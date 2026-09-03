// CGT-001A: realised capital gains domain and read service.
//
// Part 1 (pure, no DB): `domain/gains/eligibility.ts`'s discount-eligibility
// boundary tests, `domain/gains/disposal-rows.ts`'s per-allocation row
// derivation, and `domain/gains/fy-aggregation.ts`'s per-FY ordering rule
// with independently hand-computed exact decimals (see each test's
// comment).
//
// Part 2 (migrated in-memory D1-shaped DB): `app/owned-capital-gains.ts`'s
// owner-scoped read service -- publication-pointer discipline (a stale or
// unpublished run is invisible), cross-user isolation, a multi-lot disposal
// split across an eligible and an ineligible tax lot, and the empty
// "no disposals yet" state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import { loadOwnedCapitalGains } from "../app/owned-capital-gains.ts";
import {
  CGT_INDIVIDUAL_DISCOUNT_RATE,
  addTwelveMonths,
  evaluateDiscountEligibility,
} from "../domain/gains/eligibility.ts";
import {
  deriveCapitalGainDisposalRow,
  type CapitalGainAllocationFact,
  type CapitalGainDisposalRow,
} from "../domain/gains/disposal-rows.ts";
import { computeFyCapitalGainsTotals } from "../domain/gains/fy-aggregation.ts";
import { CGT_CARRY_FORWARD_NOTE } from "../domain/gains/carry-forward.ts";

// ===========================================================================
// Part 1a: discount eligibility boundaries (domain/gains/eligibility.ts)
// ===========================================================================

test("CGT-001A eligibility: disposal exactly one year later (same month/day) is NOT eligible", () => {
  // Held from 2024-06-15 to 2025-06-15: exactly 12 months, not "strictly
  // more than 12 months" -- the ATO rule requires at least one more day.
  const result = evaluateDiscountEligibility("2024-06-15", "2025-06-15");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.thresholdDate, "2025-06-15");
  assert.equal(result.eligible, false);
});

test("CGT-001A eligibility: one day after the threshold is eligible (366-day span across a leap day)", () => {
  // 2024 is a leap year, so 2024-06-15 -> 2025-06-16 spans 366 days, but the
  // rule is calendar-month arithmetic, not day-counting: one day past the
  // acquisition-date-plus-12-months threshold is eligible regardless of the
  // exact elapsed day count.
  const result = evaluateDiscountEligibility("2024-06-15", "2025-06-16");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.eligible, true);
});

test("CGT-001A eligibility: one day before the threshold (364 days) is not eligible", () => {
  const result = evaluateDiscountEligibility("2024-06-15", "2025-06-14");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.eligible, false);
});

test("CGT-001A eligibility: exactly 365 days after a non-leap acquisition is not eligible", () => {
  // 2023 -> 2024 spans a leap day (2024-02-29), so 2023-06-15 to
  // 2024-06-14 is 365 elapsed days but still exactly at the calendar
  // threshold minus one day -- not eligible, same as the 364-day case.
  const result = evaluateDiscountEligibility("2023-06-15", "2024-06-14");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.eligible, false);
  const oneMoreDay = evaluateDiscountEligibility("2023-06-15", "2024-06-15");
  assert.ok(oneMoreDay.ok);
  if (!oneMoreDay.ok) return;
  assert.equal(oneMoreDay.eligible, false); // still exactly at the threshold
  const eligible = evaluateDiscountEligibility("2023-06-15", "2024-06-16");
  assert.ok(eligible.ok);
  if (!eligible.ok) return;
  assert.equal(eligible.eligible, true);
});

test("CGT-001A eligibility: 29 Feb acquisition clamps its 12-month threshold down to 28 Feb (documented date-rolling convention)", () => {
  // Date-rolling convention (documented in eligibility.ts): adding 12
  // months to 29 Feb always lands one year later on the SAME month, but
  // 2025 is not a leap year so 29 Feb 2025 does not exist -- clamp DOWN to
  // 28 Feb 2025, never roll forward to 1 Mar as JS `Date` would.
  assert.equal(addTwelveMonths("2024-02-29"), "2025-02-28");
  const atThreshold = evaluateDiscountEligibility("2024-02-29", "2025-02-28");
  assert.ok(atThreshold.ok);
  if (!atThreshold.ok) return;
  assert.equal(atThreshold.thresholdDate, "2025-02-28");
  assert.equal(atThreshold.eligible, false); // exactly at the clamped threshold
});

test("CGT-001A eligibility: 29 Feb acquisition is eligible the day after the clamped threshold", () => {
  const result = evaluateDiscountEligibility("2024-02-29", "2025-03-01");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.eligible, true);
});

test("CGT-001A eligibility: 29 Feb acquisition disposed in a later leap year uses the real 29 Feb threshold", () => {
  // 2024-02-29 + 12 months into 2028 (a leap year, since we're testing the
  // 4-years-later leap-to-leap case) is NOT what addTwelveMonths computes
  // (that is always +1 year); confirm the ordinary +1-year leap-to-non-leap
  // clamp is the only special case, and a disposal several years out is
  // simply well after the threshold either way.
  const result = evaluateDiscountEligibility("2024-02-29", "2028-02-29");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.eligible, true);
});

test("CGT-001A eligibility: 28 Feb non-leap acquisition disposed on 29 Feb the following leap year is eligible", () => {
  const result = evaluateDiscountEligibility("2023-02-28", "2024-02-29");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.thresholdDate, "2024-02-28");
  assert.equal(result.eligible, true); // one day past the (unclamped) threshold
});

test("CGT-001A eligibility: month-end acquisitions (31-day month) never need clamping", () => {
  assert.equal(addTwelveMonths("2024-01-31"), "2025-01-31");
  assert.equal(addTwelveMonths("2024-12-31"), "2025-12-31");
});

test("CGT-001A eligibility: malformed or impossible calendar dates are typed failures", () => {
  assert.deepEqual(evaluateDiscountEligibility("not-a-date", "2025-01-01"), {
    ok: false,
    reason: "invalid_acquired_date",
  });
  assert.deepEqual(evaluateDiscountEligibility("2024-01-01", "2024-02-30"), {
    ok: false,
    reason: "invalid_disposed_date",
  });
  assert.deepEqual(evaluateDiscountEligibility("2023-02-29", "2024-01-01"), {
    ok: false,
    reason: "invalid_acquired_date",
  }); // 2023 is not a leap year -- 29 Feb 2023 never existed
});

test("CGT-001A: the individual discount rate is a documented, exported 50% constant", () => {
  assert.equal(CGT_INDIVIDUAL_DISCOUNT_RATE, "0.50");
});

// ===========================================================================
// Part 1b: per-disposal row derivation (domain/gains/disposal-rows.ts)
// ===========================================================================

function fact(
  overrides: Partial<CapitalGainAllocationFact> = {},
): CapitalGainAllocationFact {
  return {
    allocationId: "alloc-1",
    portfolioSecurityId: "membership-a",
    securitySymbol: "ABC",
    securityName: "ABC Holdings",
    acquiredDate: "2024-01-01",
    disposedDate: "2025-06-01",
    matchedQuantityDecimal: "10",
    allocatedBaseBasisDecimal: "100",
    baseNetProceedsDecimal: "150",
    feeBaseDecimal: "1",
    taxBaseDecimal: "0",
    baseRealisedGainDecimal: "50",
    basisStatus: "complete",
    ...overrides,
  };
}

test("CGT-001A rows: a complete gain held >12 months is discount_eligible", () => {
  const result = deriveCapitalGainDisposalRow(fact());
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.row.eligibility, "discount_eligible");
  assert.equal(result.row.holdingPeriodEligible, true);
  assert.equal(result.row.gainDecimal, "50");
});

test("CGT-001A rows: a complete gain held <=12 months is discount_ineligible", () => {
  const result = deriveCapitalGainDisposalRow(
    fact({ acquiredDate: "2025-01-01", disposedDate: "2025-06-01" }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.row.eligibility, "discount_ineligible");
  assert.equal(result.row.holdingPeriodEligible, false);
});

test("CGT-001A rows: a loss is never discount-applicable, even when held long enough", () => {
  const result = deriveCapitalGainDisposalRow(
    fact({ baseRealisedGainDecimal: "-20" }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.row.eligibility, "not_applicable_loss");
  // Holding-period fact is still a pure function of the dates -- computable
  // even though the discount doesn't apply to a loss.
  assert.equal(result.row.holdingPeriodEligible, true);
});

test("CGT-001A rows: an exact-zero gain is its own label, not folded into gain or loss", () => {
  const result = deriveCapitalGainDisposalRow(
    fact({ baseRealisedGainDecimal: "0" }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.row.eligibility, "not_applicable_zero");
});

test("CGT-001A rows: incomplete basis never fabricates a zero gain, but the date fact stays computable", () => {
  const result = deriveCapitalGainDisposalRow(
    fact({
      basisStatus: "incomplete_fx",
      baseRealisedGainDecimal: null,
      allocatedBaseBasisDecimal: null,
      baseNetProceedsDecimal: null,
    }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.row.gainDecimal, null);
  assert.equal(result.row.eligibility, "unknown_incomplete_basis");
  assert.equal(result.row.holdingPeriodEligible, true);
  assert.equal(result.row.basisDecimal, null);
});

test("CGT-001A rows: an invalid date is a typed failure, not a thrown exception or a zeroed row", () => {
  const result = deriveCapitalGainDisposalRow(
    fact({ acquiredDate: "2024-13-01" }),
  );
  assert.deepEqual(result, { ok: false, reason: "invalid_acquired_date" });
});

// ===========================================================================
// Part 1c: per-FY aggregation ordering rule (domain/gains/fy-aggregation.ts)
// ===========================================================================

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

test("CGT-001A FY ordering: losses offset non-discountable gains first, remainder against discountable, then 50% discount", () => {
  // Independently hand-computed expectation (all whole-dollar amounts, no
  // rounding needed at any step):
  //   discountable gain gross   = 1000
  //   non-discountable gain gross = 300
  //   losses (magnitude)        = 800
  //   loss -> non-discountable first: min(800, 300) = 300; remaining non-discountable = 300 - 300 = 0
  //   loss remaining after that: 800 - 300 = 500
  //   loss -> discountable: min(500, 1000) = 500; remaining discountable = 1000 - 500 = 500
  //   unabsorbed loss = 500 - 500 = 0
  //   discount applied = 500 * 0.50 = 250
  //   net capital gain estimate = remaining non-discountable (0) + (500 - 250) = 250
  const rows: CapitalGainDisposalRow[] = [
    row({
      allocationId: "discountable",
      gainDecimal: "1000",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
    row({
      allocationId: "non-discountable",
      gainDecimal: "300",
      holdingPeriodEligible: false,
      eligibility: "discount_ineligible",
    }),
    row({
      allocationId: "loss",
      gainDecimal: "-800",
      holdingPeriodEligible: true,
      eligibility: "not_applicable_loss",
    }),
  ];
  const result = computeFyCapitalGainsTotals(rows, 7);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.totals.length, 1);
  const total = result.totals[0]!;
  assert.equal(total.label, "FY26");
  assert.equal(total.totalDiscountableGainsGrossDecimal, "1000");
  assert.equal(total.totalNonDiscountableGainsGrossDecimal, "300");
  assert.equal(total.totalLossesDecimal, "800");
  assert.equal(total.lossAppliedToNonDiscountableDecimal, "300");
  assert.equal(total.remainingNonDiscountableAfterLossDecimal, "0");
  assert.equal(total.lossAppliedToDiscountableDecimal, "500");
  assert.equal(total.remainingDiscountableAfterLossDecimal, "500");
  assert.equal(total.discountAppliedDecimal, "250");
  assert.equal(total.netCapitalGainEstimateDecimal, "250");
  assert.equal(total.unabsorbedLossDecimal, "0");
  assert.equal(total.disposalCount, 3);
  assert.equal(total.partialCoverage, false);
});

test("CGT-001A FY ordering: losses exceeding total gains fully absorb both buckets, net gain is 0, and the excess is disclosed (never a negative taxable gain)", () => {
  // Hand-computed: discountable=100, non-discountable=50, loss=500.
  //   loss -> non-discountable: min(500,50)=50; remaining non-discountable=0; loss remaining=450
  //   loss -> discountable: min(450,100)=100; remaining discountable=0; unabsorbed=450-100=350
  //   discount applied = 0 * 0.50 = 0; net capital gain estimate = 0
  const rows: CapitalGainDisposalRow[] = [
    row({ allocationId: "d", gainDecimal: "100", holdingPeriodEligible: true }),
    row({
      allocationId: "nd",
      gainDecimal: "50",
      holdingPeriodEligible: false,
    }),
    row({ allocationId: "loss", gainDecimal: "-500" }),
  ];
  const result = computeFyCapitalGainsTotals(rows, 7);
  assert.ok(result.ok);
  if (!result.ok) return;
  const total = result.totals[0]!;
  assert.equal(total.remainingNonDiscountableAfterLossDecimal, "0");
  assert.equal(total.remainingDiscountableAfterLossDecimal, "0");
  assert.equal(total.discountAppliedDecimal, "0");
  assert.equal(total.netCapitalGainEstimateDecimal, "0");
  assert.equal(total.unabsorbedLossDecimal, "350");
  assert.ok(CGT_CARRY_FORWARD_NOTE.length > 0);
});

test("CGT-001A FY ordering: decimal exactness through sum/offset/discount with many fractional digits", () => {
  // Chosen so every intermediate step terminates exactly (no repeating
  // decimals), proving the pipeline never routes through binary float:
  //   discountable gross = 1000.123456789012345678
  //   non-discountable gross = 200.111111111111111111
  //   loss = 300.111111111111111111
  //   loss -> non-discountable: min(300.111111111111111111, 200.111111111111111111) = 200.111111111111111111
  //     remaining non-discountable = 0
  //     loss remaining = 300.111111111111111111 - 200.111111111111111111 = 100
  //   loss -> discountable: min(100, 1000.123456789012345678) = 100
  //     remaining discountable = 1000.123456789012345678 - 100 = 900.123456789012345678
  //   discount applied = 900.123456789012345678 * 0.50 = 450.061728394506172839
  //   net = 0 + (900.123456789012345678 - 450.061728394506172839) = 450.061728394506172839
  const rows: CapitalGainDisposalRow[] = [
    row({
      allocationId: "d",
      gainDecimal: "1000.123456789012345678",
      holdingPeriodEligible: true,
    }),
    row({
      allocationId: "nd",
      gainDecimal: "200.111111111111111111",
      holdingPeriodEligible: false,
    }),
    row({ allocationId: "loss", gainDecimal: "-300.111111111111111111" }),
  ];
  const result = computeFyCapitalGainsTotals(rows, 7);
  assert.ok(result.ok);
  if (!result.ok) return;
  const total = result.totals[0]!;
  assert.equal(total.remainingNonDiscountableAfterLossDecimal, "0");
  assert.equal(
    total.remainingDiscountableAfterLossDecimal,
    "900.123456789012345678",
  );
  assert.equal(total.discountAppliedDecimal, "450.061728394506172839");
  assert.equal(total.netCapitalGainEstimateDecimal, "450.061728394506172839");
});

test("CGT-001A FY: incomplete-basis allocations are excluded from totals and disclosed by name, never folded in as zero", () => {
  const rows: CapitalGainDisposalRow[] = [
    row({
      allocationId: "complete",
      gainDecimal: "100",
      holdingPeriodEligible: true,
    }),
    row({
      allocationId: "incomplete-1",
      securityName: "XYZ Mining",
      gainDecimal: null,
      basisStatus: "incomplete_fx",
      eligibility: "unknown_incomplete_basis",
    }),
    row({
      allocationId: "incomplete-2",
      securityName: "XYZ Mining", // same security, second incomplete row -- dedup expected
      gainDecimal: null,
      basisStatus: "incomplete_basis",
      eligibility: "unknown_incomplete_basis",
    }),
    row({
      allocationId: "incomplete-3",
      securityName: "Another Co",
      gainDecimal: null,
      basisStatus: "incomplete_basis",
      eligibility: "unknown_incomplete_basis",
    }),
  ];
  const result = computeFyCapitalGainsTotals(rows, 7);
  assert.ok(result.ok);
  if (!result.ok) return;
  const total = result.totals[0]!;
  assert.equal(total.disposalCount, 4);
  assert.equal(total.excludedIncompleteCount, 3);
  assert.deepEqual(total.excludedIncompleteSecurityNames, [
    "Another Co",
    "XYZ Mining",
  ]);
  assert.equal(total.partialCoverage, true);
  // The complete row's gain alone drives the totals -- the incomplete rows
  // never contribute a fabricated zero to any sum.
  assert.equal(total.totalDiscountableGainsGrossDecimal, "100");
  assert.equal(total.netCapitalGainEstimateDecimal, "50"); // 100 * 0.50 discount, no losses
});

test("CGT-001A FY (reviewer fixture, round 2): a schema-permitted row carrying basisStatus:'complete' with a NULL gain is excluded and disclosed, never throws", () => {
  // `CapitalGainDisposalRow`'s `basisStatus` and `gainDecimal` fields are
  // independently settable -- nothing in the TYPE (or the DB schema
  // `deriveCapitalGainDisposalRow` reads from) forbids a row that claims
  // 'complete' while its gain is unknown. Before this fix, bucketing on
  // `basisStatus` alone fed that `null` straight into `parseDecimalResult`,
  // throwing an opaque "Invalid decimal string." instead of disclosing the
  // row as incomplete like every other unknown-gain row.
  const rows: CapitalGainDisposalRow[] = [
    row({
      allocationId: "known",
      gainDecimal: "100",
      holdingPeriodEligible: true,
    }),
    row({
      allocationId: "complete-but-null-gain",
      securityName: "Suspicious Co",
      basisStatus: "complete",
      gainDecimal: null,
      eligibility: "unknown_incomplete_basis",
    }),
  ];
  assert.doesNotThrow(() => computeFyCapitalGainsTotals(rows, 7));
  const result = computeFyCapitalGainsTotals(rows, 7);
  assert.ok(result.ok);
  if (!result.ok) return;
  const total = result.totals[0]!;
  assert.equal(total.disposalCount, 2);
  assert.equal(total.excludedIncompleteCount, 1);
  assert.deepEqual(total.excludedIncompleteSecurityNames, ["Suspicious Co"]);
  assert.equal(total.partialCoverage, true);
  assert.equal(total.totalDiscountableGainsGrossDecimal, "100");
  assert.equal(total.netCapitalGainEstimateDecimal, "50");
});

test("CGT-001A FY: disposals exactly on the FY boundary land in the correct financial year", () => {
  // July-start FY: 2025-06-30 is the LAST day of FY25 (2024-07-01..2025-06-30);
  // 2025-07-01 is the FIRST day of FY26.
  const rows: CapitalGainDisposalRow[] = [
    row({
      allocationId: "fy25",
      disposedDate: "2025-06-30",
      gainDecimal: "10",
    }),
    row({
      allocationId: "fy26",
      disposedDate: "2025-07-01",
      gainDecimal: "20",
    }),
  ];
  const result = computeFyCapitalGainsTotals(rows, 7);
  assert.ok(result.ok);
  if (!result.ok) return;
  const byLabel = new Map(result.totals.map((total) => [total.label, total]));
  assert.equal(byLabel.get("FY25")?.disposalCount, 1);
  assert.equal(byLabel.get("FY26")?.disposalCount, 1);
  // Newest-FY-first ordering, mirroring domain/dividends/aggregations.ts.
  assert.deepEqual(
    result.totals.map((total) => total.label),
    ["FY26", "FY25"],
  );
});

test("CGT-001A FY: a non-July (calendar-year) start month buckets by ending year, not July-June", () => {
  const rows: CapitalGainDisposalRow[] = [
    row({ allocationId: "cy25", disposedDate: "2025-12-31", gainDecimal: "5" }),
    row({ allocationId: "cy26", disposedDate: "2026-01-01", gainDecimal: "7" }),
  ];
  const result = computeFyCapitalGainsTotals(rows, 1);
  assert.ok(result.ok);
  if (!result.ok) return;
  const byLabel = new Map(result.totals.map((total) => [total.label, total]));
  assert.equal(byLabel.get("FY25")?.disposalCount, 1);
  assert.equal(byLabel.get("FY26")?.disposalCount, 1);
});

test("CGT-001A FY: an invalid start month is a typed failure", () => {
  const result = computeFyCapitalGainsTotals([row({})], 13);
  assert.deepEqual(result, { ok: false, reason: "invalid_start_month" });
});

test("CGT-001A FY: a malformed disposed date on a row is a typed failure, not a crash", () => {
  const result = computeFyCapitalGainsTotals(
    [row({ disposedDate: "not-a-date" })],
    7,
  );
  assert.deepEqual(result, { ok: false, reason: "invalid_date" });
});

test("CGT-001A FY: a year with no disposals at all is simply not returned (no fabricated zero year)", () => {
  const result = computeFyCapitalGainsTotals([], 7);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.totals, []);
});

// ===========================================================================
// Part 2: owner-scoped read service (app/owned-capital-gains.ts)
// ===========================================================================

async function createMigratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const migrationFiles = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    database.exec(
      await readFile(
        new URL(`../drizzle/${migrationFile}`, import.meta.url),
        "utf8",
      ),
    );
  }
  return database;
}

function seedBase(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version) VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
      ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, default_holding_currency_view, financial_year_start_month, created_at, updated_at, version) VALUES
      ('user-a', 'AUD', 'Australia/Sydney', 'home', 7, '2026-08-03', '2026-08-03', 1),
      ('user-b', 'AUD', 'Australia/Sydney', 'home', 7, '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version) VALUES
      ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
      ('portfolio-b', 'user-b', 'B', 'Bob', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, created_at, updated_at) VALUES
      ('security-a', 'equity', 'AUD', 'ABC Holdings', '2026-08-03', '2026-08-03'),
      ('security-c', 'equity', 'AUD', 'XYZ Mining', '2026-08-03', '2026-08-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at) VALUES
      ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'hidden', '2026-08-03', '2026-08-03'),
      ('membership-c', 'user-a', 'portfolio-a', 'security-c', 'XYZ', 'AUD', 'hidden', '2026-08-03', '2026-08-03'),
      ('membership-b', 'user-b', 'portfolio-b', 'security-a', 'ABC', 'AUD', 'hidden', '2026-08-03', '2026-08-03');
  `);
}

function insertTransaction(
  database: DatabaseSync,
  values: {
    id: string;
    userId?: string;
    portfolioId?: string;
    portfolioSecurityId?: string;
    type: string;
    status?: string;
    tradeAt: string;
    localTradeDate?: string;
    quantityDecimal?: string | null;
    unitPriceDecimal?: string | null;
    grossAmountDecimal?: string | null;
    reversesTransactionId?: string | null;
  },
): void {
  const userId = values.userId ?? "user-a";
  const portfolioId = values.portfolioId ?? "portfolio-a";
  database
    .prepare(
      `INSERT INTO transactions (
        id, user_id, portfolio_id, portfolio_security_id, type, status,
        trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
        currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal,
        source_type, source_reference, reverses_transaction_id,
        created_by_user_id, calculation_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUD', ?, '0', '0', 'manual', ?, ?, ?, 1, ?)`,
    )
    .run(
      values.id,
      userId,
      portfolioId,
      values.portfolioSecurityId ?? "membership-a",
      values.type,
      values.status ?? "posted",
      values.tradeAt,
      values.localTradeDate ?? values.tradeAt.slice(0, 10),
      values.quantityDecimal ?? null,
      values.unitPriceDecimal ?? null,
      values.grossAmountDecimal ?? null,
      values.id,
      values.reversesTransactionId ?? null,
      userId,
      values.tradeAt.slice(0, 10),
    );
}

function insertCalculationRun(
  database: DatabaseSync,
  values: {
    id: string;
    userId?: string;
    portfolioId?: string;
    version?: number;
    status?: string;
    highWaterStart: string;
    highWaterEnd?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO calculation_runs (
        id, user_id, portfolio_id, range_from, range_to, calculation_version,
        reason, status, ledger_high_water_start, ledger_high_water_end,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, '2026-01-01', '2026-12-31', ?, 'transaction_change', ?, ?, ?, ?, '2026-08-03', '2026-08-03')`,
    )
    .run(
      values.id,
      values.userId ?? "user-a",
      values.portfolioId ?? "portfolio-a",
      values.version ?? 1,
      values.status ?? "completed",
      values.highWaterStart,
      values.highWaterEnd ?? null,
      `key-${values.id}`,
    );
}

function insertPublication(
  database: DatabaseSync,
  values: {
    userId?: string;
    portfolioId?: string;
    calculationRunId: string;
    calculationVersion?: number;
    ledgerHighWater: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO projection_publications (
        user_id, portfolio_id, calculation_run_id, calculation_version,
        ledger_high_water, published_at
      ) VALUES (?, ?, ?, ?, ?, '2026-08-03T01:00:00Z')`,
    )
    .run(
      values.userId ?? "user-a",
      values.portfolioId ?? "portfolio-a",
      values.calculationRunId,
      values.calculationVersion ?? 1,
      values.ledgerHighWater,
    );
}

// `value ?? fallback` is wrong for these optional decimal columns: an
// explicit `null` (a deliberately UNKNOWN amount, the whole point of the
// incomplete-basis fixtures below) would coalesce right back to the
// fallback, since `??` only defers to a fallback on `undefined`. Only an
// omitted (`undefined`) field should take the default.
function withDefault<T>(value: T | null | undefined, fallback: T): T | null {
  return value === undefined ? fallback : value;
}

function insertTaxLot(
  database: DatabaseSync,
  values: {
    id: string;
    userId?: string;
    portfolioId?: string;
    portfolioSecurityId?: string;
    openingTransactionId: string;
    acquiredAt: string;
    originalQuantityDecimal?: string;
    openQuantityDecimal?: string;
    nativeBasisDecimal?: string | null;
    baseBasisDecimal?: string | null;
    basisStatus?: string;
    status?: string;
    calculationRunId: string;
    calculationVersion?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO tax_lots (
        id, user_id, portfolio_id, portfolio_security_id, opening_transaction_id,
        acquired_at, original_quantity_decimal, open_quantity_decimal,
        native_basis_decimal, base_basis_decimal, basis_status, status,
        calculation_run_id, calculation_version, rebuilt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-03T01:00:00Z')`,
    )
    .run(
      values.id,
      values.userId ?? "user-a",
      values.portfolioId ?? "portfolio-a",
      values.portfolioSecurityId ?? "membership-a",
      values.openingTransactionId,
      values.acquiredAt,
      values.originalQuantityDecimal ?? "10",
      values.openQuantityDecimal ?? "0",
      withDefault(values.nativeBasisDecimal, "100"),
      withDefault(values.baseBasisDecimal, "100"),
      values.basisStatus ?? "complete",
      values.status ?? "closed",
      values.calculationRunId,
      values.calculationVersion ?? 1,
    );
}

function insertLotAllocation(
  database: DatabaseSync,
  values: {
    id: string;
    userId?: string;
    portfolioId?: string;
    portfolioSecurityId?: string;
    sellTransactionId: string;
    taxLotId: string;
    sequence?: number;
    matchedQuantityDecimal?: string;
    allocatedBaseBasisDecimal?: string | null;
    baseNetProceedsDecimal?: string | null;
    feeBaseDecimal?: string | null;
    taxBaseDecimal?: string | null;
    baseRealisedGainDecimal?: string | null;
    basisStatus?: string;
    calculationRunId: string;
    calculationVersion?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO lot_allocations (
        id, user_id, portfolio_id, portfolio_security_id, sell_transaction_id,
        tax_lot_id, allocation_sequence, matched_quantity_decimal,
        allocated_base_basis_decimal, base_net_proceeds_decimal,
        fee_base_decimal, tax_base_decimal, base_realised_gain_decimal,
        basis_status, calculation_run_id, calculation_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.id,
      values.userId ?? "user-a",
      values.portfolioId ?? "portfolio-a",
      values.portfolioSecurityId ?? "membership-a",
      values.sellTransactionId,
      values.taxLotId,
      values.sequence ?? 1,
      values.matchedQuantityDecimal ?? "5",
      withDefault(values.allocatedBaseBasisDecimal, "50"),
      withDefault(values.baseNetProceedsDecimal, "80"),
      withDefault(values.feeBaseDecimal, "0"),
      withDefault(values.taxBaseDecimal, "0"),
      withDefault(values.baseRealisedGainDecimal, "30"),
      values.basisStatus ?? "complete",
      values.calculationRunId,
      values.calculationVersion ?? 1,
    );
}

test("CGT-001A service: a portfolio with no disposals ever reports the empty state without requiring a published run", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2026-01-01T10:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  const client = createSqliteSqlClient(database);
  const history = await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  assert.equal(history.disposalCount, 0);
  assert.deepEqual(history.fyTotals, []);
  assert.equal(history.baseCurrencyCode, "AUD");
  assert.equal(history.financialYearStartMonth, 7);
});

test("CGT-001A service: an active sell with no published run yet fails typed instead of silently reporting empty", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2025-01-01T10:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    tradeAt: "2026-01-15T10:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  insertCalculationRun(database, {
    id: "run-running",
    status: "running",
    highWaterStart: "tx-sell",
    highWaterEnd: null,
  });
  const client = createSqliteSqlClient(database);
  await assert.rejects(
    () => loadOwnedCapitalGains(client, "user-a", "portfolio-a"),
    /invalid_projection_publication_count/,
  );
});

test("CGT-001A service: only the current published run's allocations are visible -- a stale superseded run is invisible", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2024-01-01T10:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    tradeAt: "2026-01-15T10:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });

  // Stale run: completed once, has its own tax lot/allocation, but is NOT
  // the currently published run.
  insertCalculationRun(database, {
    id: "run-stale",
    version: 1,
    status: "completed",
    highWaterStart: "tx-buy",
    highWaterEnd: "tx-sell-old",
  });
  insertTaxLot(database, {
    id: "lot-stale",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T10:00:00Z",
    calculationRunId: "run-stale",
  });
  insertLotAllocation(database, {
    id: "allocation-stale",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-stale",
    baseRealisedGainDecimal: "999999", // would be very obviously wrong if visible
    calculationRunId: "run-stale",
  });

  // Current run: completed and published -- this is the only one that
  // should be visible.
  insertCalculationRun(database, {
    id: "run-current",
    version: 2,
    status: "completed",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  insertTaxLot(database, {
    id: "lot-current",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T10:00:00Z",
    calculationRunId: "run-current",
    calculationVersion: 2,
  });
  insertLotAllocation(database, {
    id: "allocation-current",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-current",
    baseRealisedGainDecimal: "42",
    calculationRunId: "run-current",
    calculationVersion: 2,
  });
  insertPublication(database, {
    calculationRunId: "run-current",
    calculationVersion: 2,
    ledgerHighWater: "tx-sell",
  });

  const client = createSqliteSqlClient(database);
  const history = await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  assert.equal(history.disposalCount, 1);
  const row = history.fyTotals[0]?.rows[0];
  assert.equal(row?.allocationId, "allocation-current");
  assert.equal(row?.gainDecimal, "42");
});

test("CGT-001A service: cross-user isolation -- loading another user's portfolio is rejected", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  const client = createSqliteSqlClient(database);
  await assert.rejects(
    () => loadOwnedCapitalGains(client, "user-a", "portfolio-b"),
    /not_owned/,
  );
});

test("CGT-001A service: cross-user isolation -- one user's disposals never leak into another user's totals", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
    type: "buy",
    tradeAt: "2024-01-01T10:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
    type: "sell",
    tradeAt: "2026-01-15T10:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  insertCalculationRun(database, {
    id: "run-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
    highWaterStart: "tx-sell-a",
    highWaterEnd: "tx-sell-a",
  });
  insertTaxLot(database, {
    id: "lot-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
    openingTransactionId: "tx-buy-a",
    acquiredAt: "2024-01-01T10:00:00Z",
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
    sellTransactionId: "tx-sell-a",
    taxLotId: "lot-a",
    baseRealisedGainDecimal: "30",
    calculationRunId: "run-a",
  });
  insertPublication(database, {
    userId: "user-a",
    portfolioId: "portfolio-a",
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell-a",
  });

  // user-b's own portfolio has never had a sell -- should be the ordinary
  // empty state, untouched by user-a's disposal above.
  const client = createSqliteSqlClient(database);
  const bHistory = await loadOwnedCapitalGains(client, "user-b", "portfolio-b");
  assert.equal(bHistory.disposalCount, 0);

  const aHistory = await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  assert.equal(aHistory.disposalCount, 1);
});

test("CGT-001A service: a multi-lot disposal splits eligibility per allocation (one eligible lot, one ineligible lot, same sell)", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy-old",
    type: "buy",
    tradeAt: "2024-01-01T09:00:00Z",
    localTradeDate: "2024-01-01",
    quantityDecimal: "5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "50",
  });
  insertTransaction(database, {
    id: "tx-buy-recent",
    type: "buy",
    tradeAt: "2025-12-01T09:00:00Z",
    localTradeDate: "2025-12-01",
    quantityDecimal: "5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "50",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    tradeAt: "2026-01-15T09:00:00Z",
    localTradeDate: "2026-01-15",
    quantityDecimal: "10",
    unitPriceDecimal: "20",
    grossAmountDecimal: "200",
  });
  insertCalculationRun(database, {
    id: "run-a",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  // Lot 1: acquired 2024-01-01, well over 12 months before the 2026-01-15
  // disposal -- eligible.
  insertTaxLot(database, {
    id: "lot-old",
    openingTransactionId: "tx-buy-old",
    acquiredAt: "2024-01-01T09:00:00Z",
    calculationRunId: "run-a",
  });
  // Lot 2: acquired 2025-12-01, well under 12 months before disposal --
  // ineligible.
  insertTaxLot(database, {
    id: "lot-recent",
    openingTransactionId: "tx-buy-recent",
    acquiredAt: "2025-12-01T09:00:00Z",
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-old",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-old",
    sequence: 1,
    baseRealisedGainDecimal: "50",
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-recent",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-recent",
    sequence: 2,
    baseRealisedGainDecimal: "20",
    calculationRunId: "run-a",
  });
  insertPublication(database, {
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell",
  });

  const client = createSqliteSqlClient(database);
  const history = await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  assert.equal(history.disposalCount, 2);
  const total = history.fyTotals[0]!;
  const byId = new Map(total.rows.map((row) => [row.allocationId, row]));
  assert.equal(byId.get("allocation-old")?.acquiredDate, "2024-01-01");
  assert.equal(byId.get("allocation-old")?.disposedDate, "2026-01-15");
  assert.equal(byId.get("allocation-old")?.eligibility, "discount_eligible");
  assert.equal(byId.get("allocation-recent")?.acquiredDate, "2025-12-01");
  assert.equal(
    byId.get("allocation-recent")?.eligibility,
    "discount_ineligible",
  );
  assert.equal(total.totalDiscountableGainsGrossDecimal, "50");
  assert.equal(total.totalNonDiscountableGainsGrossDecimal, "20");
});

test("CGT-001A service: incomplete-basis allocations surface via the security's real name, joined from securities/portfolio_securities", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    portfolioSecurityId: "membership-c",
    type: "buy",
    tradeAt: "2024-01-01T09:00:00Z",
    localTradeDate: "2024-01-01",
    quantityDecimal: "5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "50",
  });
  insertTransaction(database, {
    id: "tx-sell",
    portfolioSecurityId: "membership-c",
    type: "sell",
    tradeAt: "2026-01-15T09:00:00Z",
    localTradeDate: "2026-01-15",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  insertCalculationRun(database, {
    id: "run-a",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  insertTaxLot(database, {
    id: "lot-a",
    portfolioSecurityId: "membership-c",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T09:00:00Z",
    basisStatus: "incomplete_fx",
    nativeBasisDecimal: "50",
    baseBasisDecimal: null,
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-a",
    portfolioSecurityId: "membership-c",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-a",
    allocatedBaseBasisDecimal: null,
    baseNetProceedsDecimal: null,
    feeBaseDecimal: null,
    taxBaseDecimal: null,
    baseRealisedGainDecimal: null,
    basisStatus: "incomplete_fx",
    calculationRunId: "run-a",
  });
  insertPublication(database, {
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell",
  });

  const client = createSqliteSqlClient(database);
  const history = await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  const total = history.fyTotals[0]!;
  assert.equal(total.excludedIncompleteCount, 1);
  assert.deepEqual(total.excludedIncompleteSecurityNames, ["XYZ Mining"]);
  assert.equal(total.totalDiscountableGainsGrossDecimal, "0");
  assert.equal(total.totalNonDiscountableGainsGrossDecimal, "0");
  assert.equal(total.netCapitalGainEstimateDecimal, "0");
});

test("CGT-001A service (reviewer fixture, round 2): a lot_allocations row with basis_status='complete' and a NULL base_realised_gain_decimal never throws end to end", async () => {
  // The DB schema's CHECK constraint on `lot_allocations` only pins
  // `basis_status` to its three enum values -- nothing ties it to whether
  // `base_realised_gain_decimal` is NULL, so this row is schema-permitted
  // even though the ledger projection code would never normally produce
  // it. The reviewer reproduced the previous "Invalid decimal string."
  // crash with exactly this shape at the service level.
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2024-01-01T09:00:00Z",
    localTradeDate: "2024-01-01",
    quantityDecimal: "5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "50",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    tradeAt: "2026-01-15T09:00:00Z",
    localTradeDate: "2026-01-15",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  insertCalculationRun(database, {
    id: "run-a",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  insertTaxLot(database, {
    id: "lot-a",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T09:00:00Z",
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-a",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-a",
    basisStatus: "complete", // schema-permitted alongside a NULL gain below
    baseRealisedGainDecimal: null,
    calculationRunId: "run-a",
  });
  insertPublication(database, {
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell",
  });

  const client = createSqliteSqlClient(database);
  await assert.doesNotReject(() =>
    loadOwnedCapitalGains(client, "user-a", "portfolio-a"),
  );
  const history = await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  const total = history.fyTotals[0]!;
  assert.equal(total.excludedIncompleteCount, 1);
  assert.equal(total.disposalCount, 1);
  assert.equal(total.netCapitalGainEstimateDecimal, "0");
});

test("CGT-001A service: the empty-state short-circuit's reversal-exclusion branch stays empty even when a stale, not-yet-recalculated publication still carries the reversed sell's rows", async () => {
  // Pins the docs/CALCULATIONS.md §14 caveat: the empty-state check is an
  // ACTIVE-LEDGER query (no active, non-reversed sell), not a read of
  // `lot_allocations` itself -- so it must still answer "no disposals" even
  // when an older publication physically still carries allocation rows for
  // a sell that has SINCE been reversed (the recalculation that would
  // clear them just hasn't published yet).
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2024-01-01T09:00:00Z",
    localTradeDate: "2024-01-01",
    quantityDecimal: "5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "50",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    status: "reversed",
    tradeAt: "2026-01-15T09:00:00Z",
    localTradeDate: "2026-01-15",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell-reversal",
    type: "sell",
    tradeAt: "2026-01-16T09:00:00Z",
    localTradeDate: "2026-01-16",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
    reversesTransactionId: "tx-sell",
  });
  // Stale publication: computed BEFORE the reversal above, so its
  // lot_allocations row for tx-sell is still physically present.
  insertCalculationRun(database, {
    id: "run-stale",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  insertTaxLot(database, {
    id: "lot-stale",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T09:00:00Z",
    calculationRunId: "run-stale",
  });
  insertLotAllocation(database, {
    id: "allocation-stale",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-stale",
    baseRealisedGainDecimal: "999999", // would be very obviously wrong if surfaced
    calculationRunId: "run-stale",
  });
  insertPublication(database, {
    calculationRunId: "run-stale",
    ledgerHighWater: "tx-sell",
  });

  const client = createSqliteSqlClient(database);
  const history = await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  assert.equal(history.disposalCount, 0);
  assert.deepEqual(history.fyTotals, []);
});

// ---------------------------------------------------------------------------
// PRF-011 (owner-reported production CPU-limit follow-up audit): the
// `projection_publications`/`lot_allocations` `count(*)` prechecks this
// service used to run are gone -- exactly the anti-pattern PRF-004 removed
// from `app/owned-holdings.ts`. These pin the removal itself (one query per
// table instead of two) and prove the `lot_allocations` overflow/orphan
// safety nets this service must never lose survive the rewrite.
// ---------------------------------------------------------------------------

/** Wraps a real SqliteSqlClient, recording every `all`/`get` call's SQL text
 * -- lets a test assert on the REAL query sequence `loadOwnedCapitalGains`
 * issues, mirroring `tests/prf-001.test.ts`'s `stageCensusClient` census
 * method at a scale this file does not otherwise need. */
function countingClient(database: DatabaseSync): {
  client: SqlClient;
  calls: string[];
} {
  const base = createSqliteSqlClient(database);
  const calls: string[] = [];
  const client: SqlClient = {
    all: <T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      calls.push(sql);
      return base.all<T>(sql, params);
    },
    get: <T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      calls.push(sql);
      return base.get<T>(sql, params);
    },
    run: (sql: string, params?: readonly unknown[]) => base.run(sql, params),
    batch: (statements) => base.batch(statements),
  };
  return { client, calls };
}

test("PRF-011: loadOwnedCapitalGains issues exactly ONE projection_publications query and ONE lot_allocations query -- no separate count(*) precheck for either", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2024-01-01T09:00:00Z",
    localTradeDate: "2024-01-01",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    tradeAt: "2026-01-15T09:00:00Z",
    localTradeDate: "2026-01-15",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  insertCalculationRun(database, {
    id: "run-a",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  insertTaxLot(database, {
    id: "lot-a",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T09:00:00Z",
    calculationRunId: "run-a",
  });
  insertLotAllocation(database, {
    id: "allocation-a",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-a",
    calculationRunId: "run-a",
  });
  insertPublication(database, {
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell",
  });

  const { client, calls } = countingClient(database);
  const history = await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  assert.equal(history.disposalCount, 1);

  const publicationCalls = calls.filter((sql) =>
    sql.includes("FROM projection_publications"),
  );
  assert.equal(
    publicationCalls.length,
    1,
    "expected exactly one projection_publications read (count(*) precheck removed)",
  );
  assert.doesNotMatch(
    publicationCalls[0]!,
    /count\(\*\)/i,
    "the surviving projection_publications query must be the LIMIT 2 data read, not a count",
  );

  const allocationCalls = calls.filter((sql) =>
    sql.includes("FROM lot_allocations"),
  );
  assert.equal(
    allocationCalls.length,
    1,
    "expected exactly one lot_allocations read (count(*) precheck removed)",
  );
  assert.doesNotMatch(
    allocationCalls[0]!,
    /count\(\*\)/i,
    "the surviving lot_allocations query must be the LIMIT MAX_ALLOCATIONS+1 data read, not a count",
  );
});

test("PRF-011: too_many_allocations still rejects a run whose lot_allocations exceed MAX_ALLOCATIONS (10,000), now derived from the LIMIT read's own length instead of a separate count(*)", async () => {
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2024-01-01T09:00:00Z",
    localTradeDate: "2024-01-01",
    quantityDecimal: "20000",
    unitPriceDecimal: "10",
    grossAmountDecimal: "200000",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    tradeAt: "2026-01-15T09:00:00Z",
    localTradeDate: "2026-01-15",
    quantityDecimal: "10001",
    unitPriceDecimal: "20",
    grossAmountDecimal: "200020",
  });
  insertCalculationRun(database, {
    id: "run-a",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  insertTaxLot(database, {
    id: "lot-a",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T09:00:00Z",
    originalQuantityDecimal: "20000",
    calculationRunId: "run-a",
  });
  // 10,001 allocations (MAX_ALLOCATIONS + 1) against the SAME tax lot/sell
  // pair, varying only `allocation_sequence` -- the unique index
  // (`sell_transaction_id`, `tax_lot_id`, `allocation_sequence`,
  // `calculation_run_id`) permits this, and it is far cheaper to seed than
  // 10,001 distinct lots while still exercising the real overflow path.
  database.exec("BEGIN");
  const insertAllocation = database.prepare(
    `INSERT INTO lot_allocations (
      id, user_id, portfolio_id, portfolio_security_id, sell_transaction_id,
      tax_lot_id, allocation_sequence, matched_quantity_decimal,
      allocated_base_basis_decimal, base_net_proceeds_decimal,
      fee_base_decimal, tax_base_decimal, base_realised_gain_decimal,
      basis_status, calculation_run_id, calculation_version
    ) VALUES (?, 'user-a', 'portfolio-a', 'membership-a', 'tx-sell', 'lot-a', ?, '1', '1', '2', '0', '0', '1', 'complete', 'run-a', 1)`,
  );
  const ALLOCATION_COUNT = 10_001;
  for (let index = 0; index < ALLOCATION_COUNT; index += 1) {
    insertAllocation.run(`allocation-${index}`, index + 1);
  }
  database.exec("COMMIT");
  insertPublication(database, {
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell",
  });

  const client = createSqliteSqlClient(database);
  await assert.rejects(
    () => loadOwnedCapitalGains(client, "user-a", "portfolio-a"),
    /too_many_allocations/,
  );
});

test("PRF-011: a lot_allocations row whose tax lot belongs to a DIFFERENT calculation run than the allocation itself still fails typed/closed (never silently dropped) now that the read is a LEFT JOIN driven off lot_allocations", async () => {
  // The safety net the old `allocationCount !== allocationRows.length`
  // aggregate check existed for: nothing in the schema's FKs stops a
  // `lot_allocations` row from pointing at a `tax_lot_id` whose OWN
  // `calculation_run_id` differs from the allocation's `calculation_run_id`
  // -- the query's JOIN condition requires both to match, so under the OLD
  // `INNER JOIN` this row was silently excluded from `allocationRows`
  // (caught only by the separate count comparison, throwing
  // `missing_allocation_dates`). Under the NEW `LEFT JOIN` (lot_allocations
  // is now the driving table), this same row still appears -- with its
  // `acquired_date` NULL, since `opening` only joins via `tl`.
  // PRF-011 correction (round 2, review B1): `unresolvedChainField` in
  // `app/owned-capital-gains.ts` catches this NULL explicitly and restores
  // the ORIGINAL `missing_allocation_dates` failure identity (not the
  // round-1 `invalid_acquired_date`) -- `reasonForError` in
  // `gains/page.tsx`, CGT-001B's screen copy, and docs/CALCULATIONS.md all
  // key off that one literal. A typed failure either way, never a
  // fabricated or silently under-reported disposal (AGENTS.md).
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2024-01-01T09:00:00Z",
    localTradeDate: "2024-01-01",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    tradeAt: "2026-01-15T09:00:00Z",
    localTradeDate: "2026-01-15",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  // The tax lot's OWN calculation run -- a prior run, never published.
  insertCalculationRun(database, {
    id: "run-old",
    highWaterStart: "tx-buy",
    highWaterEnd: "tx-buy",
  });
  // The CURRENT published run -- the allocation below claims this run, but
  // its tax lot (created under `run-old`) never was.
  insertCalculationRun(database, {
    id: "run-a",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  insertTaxLot(database, {
    id: "lot-mismatched",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T09:00:00Z",
    calculationRunId: "run-old",
  });
  insertLotAllocation(database, {
    id: "allocation-mismatched",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-mismatched",
    calculationRunId: "run-a",
  });
  insertPublication(database, {
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell",
  });

  const client = createSqliteSqlClient(database);
  await assert.rejects(
    () => loadOwnedCapitalGains(client, "user-a", "portfolio-a"),
    /missing_allocation_dates/,
  );
});

test("PRF-011 correction (review B1): the SAME orphan-allocation failure, driven through the REAL reasonForError in gains/page.tsx, maps to the missing_dates reason CGT-001B renders distinct copy for", async () => {
  // Reproduces the identical DB fixture as the test above (a lot_allocations
  // row whose tax lot belongs to a different, unpublished calculation run,
  // so its `acquired_date` LEFT JOIN comes back NULL) and confirms the
  // thrown `missing_allocation_dates` error is not just the loader's
  // literal -- it is what the ACTUAL page-level `reasonForError` function
  // maps to `reason: "missing_dates"`, the reason CGT-001B's screen gives
  // distinct "missing the acquisition or disposal dates" copy for (see
  // `tests/cgt-001b.test.ts`). `reasonForError` lives in a `.tsx` file that
  // transitively imports `next/headers` (via `authenticated-workspace.ts`),
  // so it cannot be imported by this plain Node test runner -- it is
  // exported and invoked via the same `tsx`-loader child-process technique
  // `tests/cgt-001b.test.ts`'s `renderComponent` uses, rather than
  // re-implemented/duplicated here (see `tests/test-runner-constraints`
  // convention).
  const database = await createMigratedDatabase();
  seedBase(database);
  insertTransaction(database, {
    id: "tx-buy",
    type: "buy",
    tradeAt: "2024-01-01T09:00:00Z",
    localTradeDate: "2024-01-01",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "tx-sell",
    type: "sell",
    tradeAt: "2026-01-15T09:00:00Z",
    localTradeDate: "2026-01-15",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  insertCalculationRun(database, {
    id: "run-old",
    highWaterStart: "tx-buy",
    highWaterEnd: "tx-buy",
  });
  insertCalculationRun(database, {
    id: "run-a",
    highWaterStart: "tx-sell",
    highWaterEnd: "tx-sell",
  });
  insertTaxLot(database, {
    id: "lot-mismatched",
    openingTransactionId: "tx-buy",
    acquiredAt: "2024-01-01T09:00:00Z",
    calculationRunId: "run-old",
  });
  insertLotAllocation(database, {
    id: "allocation-mismatched",
    sellTransactionId: "tx-sell",
    taxLotId: "lot-mismatched",
    calculationRunId: "run-a",
  });
  insertPublication(database, {
    calculationRunId: "run-a",
    ledgerHighWater: "tx-sell",
  });

  const client = createSqliteSqlClient(database);
  let thrownMessage: string | null = null;
  try {
    await loadOwnedCapitalGains(client, "user-a", "portfolio-a");
  } catch (error) {
    thrownMessage = error instanceof Error ? error.message : String(error);
  }
  assert.equal(thrownMessage, "missing_allocation_dates");

  const pageUrl = new URL(
    "../app/portfolio/[portfolioId]/gains/page.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { reasonForError } from ${JSON.stringify(pageUrl)};
    process.stdout.write(JSON.stringify(reasonForError(${JSON.stringify(thrownMessage)})));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), {
    status: "unavailable",
    reason: "missing_dates",
  });
});
