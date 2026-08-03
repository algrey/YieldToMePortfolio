import assert from "node:assert/strict";
import test from "node:test";
import {
  addDecimal,
  allocateProportional,
  calculateNativeMarketValue,
  calculateOpenBasis,
  calculateRealisedGain,
  calculateSingleDateHolding,
  compareDecimal,
  divideDecimal,
  formatDecimalFixed,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
  subtractDecimal,
} from "../domain/calculations/index.ts";
import {
  expectedFifoHoldingResult,
  fifoHoldingFixture,
} from "./fixtures/calc-001a.ts";

test("decimal primitives preserve exact values and use half-even boundaries", () => {
  const large = multiplyDecimal(
    parseDecimal("123456789012345678.90"),
    parseDecimal("3"),
  );
  assert.equal(formatDecimalFixed(large, 2), "370370367037037036.70");
  assert.equal(
    formatDecimalFixed(addDecimal(parseDecimal("0.1"), parseDecimal("0.2")), 2),
    "0.30",
  );
  assert.equal(
    formatDecimalFixed(roundDecimal(parseDecimal("2.5"), 0), 0),
    "2",
  );
  assert.equal(
    formatDecimalFixed(roundDecimal(parseDecimal("3.5"), 0), 0),
    "4",
  );
  assert.equal(
    formatDecimalFixed(roundDecimal(parseDecimal("-2.5"), 0), 0),
    "-2",
  );
  assert.equal(
    formatDecimalFixed(roundDecimal(parseDecimal("-3.5"), 0), 0),
    "-4",
  );
  assert.equal(
    formatDecimalFixed(divideDecimal(parseDecimal("1"), parseDecimal("3")), 4),
    "0.3333",
  );
  assert.equal(compareDecimal(parseDecimal("1.00"), parseDecimal("1")), 0);
  assert.equal(
    formatDecimalFixed(
      subtractDecimal(parseDecimal("10"), parseDecimal("12.5")),
      2,
    ),
    "-2.50",
  );
  assert.equal(formatDecimalFixed(parseDecimal("-0.004"), 2), "0.00");
  assert.throws(() => parseDecimal("1e3"), /Invalid decimal/);
  assert.throws(() => parseDecimal("1,000"), /Invalid decimal/);
});

test("proportional allocation assigns the exact rounded residual to the final item", () => {
  const first = allocateProportional({
    totalDecimal: "100",
    partDecimal: "1",
    denominatorDecimal: "3",
    scale: 2,
  });
  assert.deepEqual(first, {
    ok: true,
    valueDecimal: "33.33",
    nextAllocatedDecimal: "33.33",
  });
  const second = allocateProportional({
    totalDecimal: "100",
    partDecimal: "1",
    denominatorDecimal: "3",
    allocatedDecimal: first.ok ? first.nextAllocatedDecimal : "0",
    scale: 2,
  });
  const final = allocateProportional({
    totalDecimal: "100",
    partDecimal: "1",
    denominatorDecimal: "3",
    allocatedDecimal: second.ok ? second.nextAllocatedDecimal : "0",
    isFinal: true,
    scale: 2,
  });
  assert.equal(final.ok, true);
  if (final.ok) {
    assert.equal(final.valueDecimal, "33.34");
    assert.equal(final.nextAllocatedDecimal, "100");
  }
  let allocatedDecimal = "0";
  for (const [index, partDecimal] of ["2", "3", "5"].entries()) {
    const allocation = allocateProportional({
      totalDecimal: "10",
      partDecimal,
      denominatorDecimal: "10",
      allocatedDecimal,
      isFinal: index === 2,
      scale: 2,
    });
    assert.equal(allocation.ok, true);
    if (allocation.ok) allocatedDecimal = allocation.nextAllocatedDecimal;
  }
  assert.equal(allocatedDecimal, "10");
  assert.deepEqual(
    allocateProportional({
      totalDecimal: "100",
      partDecimal: "4",
      denominatorDecimal: "3",
    }),
    { ok: false, reason: "part_exceeds_denominator" },
  );
});

test("single-date FIFO holding fixtures calculate basis, value, gain, and movement", () => {
  assert.deepEqual(
    calculateSingleDateHolding(fifoHoldingFixture),
    expectedFifoHoldingResult,
  );
  assert.deepEqual(
    calculateOpenBasis([
      { remainingQuantityDecimal: "10", remainingBasisDecimal: "210" },
      { remainingQuantityDecimal: "3", remainingBasisDecimal: "50" },
    ]),
    { status: "available", valueDecimal: "260" },
  );
  assert.deepEqual(
    calculateRealisedGain({
      netProceedsDecimal: "354",
      matchedBasisDecimal: "260",
    }),
    { status: "available", valueDecimal: "94" },
  );
  assert.deepEqual(
    calculateRealisedGain({
      netProceedsDecimal: "250",
      matchedBasisDecimal: "260",
    }),
    { status: "available", valueDecimal: "-10" },
  );
});

test("missing values and zero denominators remain named unavailable results", () => {
  assert.deepEqual(
    calculateNativeMarketValue({ quantityDecimal: "10", priceDecimal: null }),
    { status: "unavailable", reason: "missing_price" },
  );
  assert.deepEqual(
    calculateSingleDateHolding({
      quantityDecimal: "10",
      priceDecimal: "20",
      previousPriceDecimal: null,
      openBasisDecimal: "0",
      realisedGainDecimal: null,
    }),
    {
      quantity: { status: "available", valueDecimal: "10" },
      nativeMarketValue: { status: "available", valueDecimal: "200" },
      previousNativeMarketValue: {
        status: "unavailable",
        reason: "missing_previous_price",
      },
      dailyMovement: {
        status: "unavailable",
        reason: "missing_previous_price",
      },
      openBasis: { status: "available", valueDecimal: "0" },
      unrealisedGain: { status: "available", valueDecimal: "200" },
      unrealisedPercent: { status: "unavailable", reason: "zero_basis" },
      realisedGain: { status: "unavailable", reason: "missing_proceeds" },
      totalGain: { status: "unavailable", reason: "missing_proceeds" },
      totalPercent: { status: "unavailable", reason: "missing_proceeds" },
    },
  );
  assert.deepEqual(
    calculateOpenBasis([
      { remainingQuantityDecimal: "2", remainingBasisDecimal: null },
    ]),
    { status: "unavailable", reason: "incomplete_basis" },
  );
});
