import assert from "node:assert/strict";
import test from "node:test";
import {
  DECIMAL_LIMITS,
  CALCULATION_LIMITS,
  addDecimal,
  allocateProportional,
  calculateNativeMarketValue,
  calculateOpenBasis,
  calculateRealisedGain,
  calculateSingleDateHolding,
  compareDecimal,
  divideDecimal,
  formatDecimalExact,
  formatDecimalFixed,
  groupThousands,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
  subtractDecimal,
} from "../domain/calculations/index.ts";
import {
  allocateFifoSale,
  applyFifoSplit,
  buildLedgerProjections,
  createFifoLot,
} from "../domain/ledger/index.ts";
import {
  expectedFifoHoldingResult,
  fifoHoldingFixture,
} from "./fixtures/calc-001a.ts";

test("reviewed decimal primitives preserve bounded source precision and half-even rounding", () => {
  const large = multiplyDecimal(
    parseDecimal("123456789012345678.90"),
    parseDecimal("3"),
  );
  assert.equal(formatDecimalExact(large), "370370367037037036.7");
  assert.equal(
    formatDecimalExact(
      multiplyDecimal(
        parseDecimal("0.123456789012345678901234"),
        parseDecimal("7.654321098765432109876543"),
      ),
    ),
    "0.944977904923029902975151828684588861743630354062",
  );
  assert.deepEqual(
    calculateNativeMarketValue({
      quantityDecimal: "0.123456789012345678901234",
      priceDecimal: "7.654321098765432109876543",
    }),
    {
      status: "available",
      valueDecimal: "0.944977904923029902975151828684588861743630354062",
    },
  );
  assert.deepEqual(
    calculateOpenBasis([
      {
        remainingQuantityDecimal: "1",
        remainingBasisDecimal: "0.123456789012345678901234",
      },
      {
        remainingQuantityDecimal: "1",
        remainingBasisDecimal: "0.000000000000000000000001",
      },
    ]),
    { status: "available", valueDecimal: "0.123456789012345678901235" },
  );
  assert.deepEqual(
    calculateRealisedGain({
      netProceedsDecimal: "100.123456789012345678901234",
      matchedBasisDecimal: "0.000000000000000000000001",
    }),
    { status: "available", valueDecimal: "100.123456789012345678901233" },
  );
  assert.equal(
    formatDecimalFixed(addDecimal(parseDecimal("0.1"), parseDecimal("0.2")), 2),
    "0.30",
  );
  assert.throws(
    () =>
      formatDecimalExact(divideDecimal(parseDecimal("1"), parseDecimal("3"))),
    /explicit rounding scale is required/,
  );
  for (const [input, expected] of [
    ["2.5", "2"],
    ["3.5", "4"],
    ["-2.5", "-2"],
    ["-3.5", "-4"],
  ] as const) {
    assert.equal(
      formatDecimalFixed(roundDecimal(parseDecimal(input), 0), 0),
      expected,
    );
  }
  assert.equal(
    formatDecimalFixed(divideDecimal(parseDecimal("1"), parseDecimal("3")), 4),
    "0.3333",
  );
  assert.equal(compareDecimal(parseDecimal("1.00"), parseDecimal("1")), 0);
  assert.equal(formatDecimalFixed(parseDecimal("-0.004"), 2), "0.00");
});

test("groupThousands inserts separators without altering exact value", () => {
  // Below the grouping threshold: unchanged.
  assert.equal(groupThousands("0.00"), "0.00");
  assert.equal(groupThousands("999.99"), "999.99");
  // Grouping the integer part; fractional digits preserved verbatim.
  assert.equal(groupThousands("1000.00"), "1,000.00");
  assert.equal(groupThousands("1234567.89"), "1,234,567.89");
  assert.equal(groupThousands("921536.34"), "921,536.34");
  // No fractional part.
  assert.equal(groupThousands("1000000"), "1,000,000");
  // Trimmed fractions (variable scale) are preserved.
  assert.equal(groupThousands("12345.6789"), "12,345.6789");
  // Both ASCII "-" and the UI minus sign U+2212 are passed through.
  assert.equal(groupThousands("-1234.56"), "-1,234.56");
  assert.equal(groupThousands("−1234567"), "−1,234,567");
});

test("decimal parsing and operation boundaries reject malformed or unbounded work", () => {
  for (const invalid of [
    "",
    " ",
    "+1",
    "01",
    "1.",
    ".1",
    "1e3",
    "1,000",
    "NaN",
    "Infinity",
    "-0",
    "-0.00",
    "9".repeat(DECIMAL_LIMITS.inputDigits + 1),
    `0.${"1".repeat(DECIMAL_LIMITS.inputScale + 1)}`,
  ]) {
    assert.throws(() => parseDecimal(invalid), /Invalid decimal/);
  }

  const maximum = parseDecimal("9".repeat(DECIMAL_LIMITS.inputDigits));
  const squared = multiplyDecimal(maximum, maximum);
  const cubed = multiplyDecimal(squared, maximum);
  const fourth = multiplyDecimal(cubed, maximum);
  assert.throws(
    () => multiplyDecimal(fourth, maximum),
    /precision exceeds the supported boundary/,
  );
  assert.throws(
    () => formatDecimalFixed(parseDecimal("1"), DECIMAL_LIMITS.resultScale + 1),
    /scale is outside the supported boundary/,
  );
});

test("bounded decimal algebra retains exact invariants", () => {
  const values = ["0", "0.0001", "1", "1.25", "999999.9999", "-7.5"];
  for (const leftValue of values) {
    for (const rightValue of values) {
      const left = parseDecimal(leftValue);
      const right = parseDecimal(rightValue);
      assert.equal(
        compareDecimal(addDecimal(left, right), addDecimal(right, left)),
        0,
      );
      assert.equal(
        compareDecimal(subtractDecimal(addDecimal(left, right), right), left),
        0,
      );
      assert.equal(
        compareDecimal(
          multiplyDecimal(left, right),
          multiplyDecimal(right, left),
        ),
        0,
      );
    }
  }
  for (const [a, b, c] of [
    ["0.1", "0.2", "0.3"],
    ["12.50", "3", "-2"],
    ["999.999", "0.001", "7"],
  ]) {
    const left = multiplyDecimal(
      parseDecimal(a),
      addDecimal(parseDecimal(b), parseDecimal(c)),
    );
    const right = addDecimal(
      multiplyDecimal(parseDecimal(a), parseDecimal(b)),
      multiplyDecimal(parseDecimal(a), parseDecimal(c)),
    );
    assert.equal(compareDecimal(left, right), 0);
  }
});

test("proportional allocations reconcile exactly and fail closed at every boundary", () => {
  for (const denominator of [3, 7, 11]) {
    let allocatedDecimal = "0";
    for (let index = 0; index < denominator; index += 1) {
      const allocation = allocateProportional({
        totalDecimal: "100.01",
        partDecimal: "1",
        denominatorDecimal: String(denominator),
        allocatedDecimal,
        isFinal: index === denominator - 1,
        scale: 2,
      });
      assert.equal(allocation.ok, true);
      if (allocation.ok) allocatedDecimal = allocation.nextAllocatedDecimal;
    }
    assert.equal(allocatedDecimal, "100.01");
  }

  assert.deepEqual(
    allocateProportional({
      totalDecimal: "100",
      partDecimal: "4",
      denominatorDecimal: "3",
    }),
    { ok: false, reason: "part_exceeds_denominator" },
  );
  assert.deepEqual(
    allocateProportional({
      totalDecimal: "-1",
      partDecimal: "1",
      denominatorDecimal: "1",
    }),
    { ok: false, reason: "negative_total" },
  );
  assert.deepEqual(
    allocateProportional({
      totalDecimal: "1",
      partDecimal: "1",
      denominatorDecimal: "0",
    }),
    { ok: false, reason: "non_positive_denominator" },
  );
  assert.deepEqual(
    allocateProportional({
      totalDecimal: "1",
      partDecimal: "1",
      denominatorDecimal: "1",
      allocatedDecimal: "2",
    }),
    { ok: false, reason: "invalid_allocated" },
  );
  assert.deepEqual(
    allocateProportional({
      totalDecimal: "1",
      partDecimal: "1",
      denominatorDecimal: "1",
      scale: DECIMAL_LIMITS.allocationScale + 1,
    }),
    { ok: false, reason: "invalid_scale" },
  );
  assert.deepEqual(
    allocateProportional({
      totalDecimal: "bad",
      partDecimal: "1",
      denominatorDecimal: "1",
    }),
    { ok: false, reason: "invalid_decimal" },
  );
});

test("ledger FIFO outputs drive the single-date holding calculation", () => {
  const lots = fifoHoldingFixture.lots.map((input) => createFifoLot(input));
  assert.ok(lots.every((lot) => lot !== null));
  const fifo = allocateFifoSale(
    lots.filter((lot) => lot !== null),
    fifoHoldingFixture.sale,
  );
  assert.equal(fifo.ok, true);
  if (!fifo.ok) return;

  const openBasis = calculateOpenBasis(
    fifo.remainingLots.map((lot) => ({
      remainingQuantityDecimal: lot.openQuantityDecimal,
      remainingBasisDecimal: lot.remainingBasisBaseDecimal,
    })),
  );
  assert.equal(openBasis.status, "available");
  const realisedGain = fifo.allocations.reduce(
    (total, allocation) =>
      addDecimal(
        total,
        parseDecimal(allocation.baseRealisedGainDecimal ?? "0"),
      ),
    parseDecimal("0"),
  );
  const quantity = fifo.remainingLots.reduce(
    (total, lot) => addDecimal(total, parseDecimal(lot.openQuantityDecimal)),
    parseDecimal("0"),
  );
  assert.deepEqual(
    calculateSingleDateHolding({
      quantityDecimal: formatDecimalExact(quantity),
      priceDecimal: fifoHoldingFixture.priceDecimal,
      previousPriceDecimal: fifoHoldingFixture.previousPriceDecimal,
      openBasisDecimal:
        openBasis.status === "available" ? openBasis.valueDecimal : null,
      realisedGainDecimal: formatDecimalExact(realisedGain),
    }),
    expectedFifoHoldingResult,
  );
});

test("production FIFO uses the bounded decimal contract and retains allocation precision", () => {
  const lot = createFifoLot({
    id: "precision-lot",
    acquiredAt: "2026-01-01T00:00:00Z",
    openingTransactionId: "precision-buy",
    quantityDecimal: "3",
    costBasisBaseDecimal: "1.123456789012345678901234",
    acquisitionFeeBaseDecimal: "0",
    acquisitionTaxBaseDecimal: "0",
  });
  assert.ok(lot);

  const allocation = allocateFifoSale([lot], {
    transactionId: "precision-sale",
    quantityDecimal: "1",
    netProceedsBaseDecimal: "1.000000000000000000000001",
    feeBaseDecimal: "0",
    taxBaseDecimal: "0",
  });
  assert.equal(allocation.ok, true);
  if (allocation.ok) {
    assert.equal(
      allocation.allocations[0]?.baseBasisDecimal,
      "0.374485596337448559633745",
    );
    assert.equal(
      allocation.allocations[0]?.baseRealisedGainDecimal,
      "0.625514403662551440366256",
    );
    assert.equal(
      allocation.remainingLots[0]?.remainingBasisBaseDecimal,
      "0.748971192674897119267489",
    );
  }

  const oversized = "9".repeat(DECIMAL_LIMITS.inputDigits + 1);
  assert.equal(
    createFifoLot({
      id: "oversized-lot",
      acquiredAt: "2026-01-01T00:00:00Z",
      openingTransactionId: "oversized-buy",
      quantityDecimal: oversized,
      costBasisBaseDecimal: "1",
      acquisitionFeeBaseDecimal: "0",
      acquisitionTaxBaseDecimal: "0",
    }),
    null,
  );
  assert.deepEqual(
    allocateFifoSale(
      [lot],
      {
        transactionId: "oversized-sale",
        quantityDecimal: "1",
        netProceedsBaseDecimal: oversized,
        feeBaseDecimal: "0",
        taxBaseDecimal: "0",
      },
      DECIMAL_LIMITS.allocationScale,
    ),
    {
      ok: false,
      reason: "invalid_decimal",
      allocations: [],
      remainingLots: [lot],
      matchedQuantityDecimal: "0",
      unmatchedQuantityDecimal: "1",
    },
  );
  assert.equal(
    applyFifoSplit([lot], {
      numeratorDecimal: "1",
      denominatorDecimal: `0.${"1".repeat(DECIMAL_LIMITS.inputScale + 1)}`,
    }),
    null,
  );
  assert.deepEqual(
    buildLedgerProjections([
      {
        id: "oversized-projection-buy",
        portfolioSecurityId: "security-a",
        type: "buy",
        status: "posted",
        tradeAt: "2026-01-01T00:00:00Z",
        quantityDecimal: oversized,
        unitPriceDecimal: "1",
        grossAmountDecimal: null,
        feeAmountDecimal: "0",
        taxAmountDecimal: "0",
        fxRateToBaseDecimal: "1",
        reversesTransactionId: null,
      },
    ]),
    {
      ok: false,
      reason: "invalid_decimal",
      eventId: "oversized-projection-buy",
    },
  );
});

test("holding calculations return stable reasons for missing, zero, negative, and bounded inputs", () => {
  assert.deepEqual(
    calculateNativeMarketValue({ quantityDecimal: "-1", priceDecimal: "10" }),
    { status: "unavailable", reason: "invalid_quantity" },
  );
  assert.deepEqual(
    calculateNativeMarketValue({ quantityDecimal: "1", priceDecimal: "0" }),
    { status: "unavailable", reason: "invalid_price" },
  );
  assert.deepEqual(
    calculateNativeMarketValue({ quantityDecimal: "1", priceDecimal: null }),
    { status: "unavailable", reason: "missing_price" },
  );
  assert.deepEqual(
    calculateRealisedGain({
      netProceedsDecimal: "-5",
      matchedBasisDecimal: "10",
    }),
    { status: "available", valueDecimal: "-15" },
  );
  assert.deepEqual(
    calculateRealisedGain({
      netProceedsDecimal: "bad",
      matchedBasisDecimal: "10",
    }),
    { status: "unavailable", reason: "invalid_proceeds" },
  );
  assert.deepEqual(
    calculateOpenBasis([
      { remainingQuantityDecimal: "0", remainingBasisDecimal: "1" },
    ]),
    { status: "unavailable", reason: "invalid_quantity" },
  );
  assert.deepEqual(
    calculateOpenBasis(
      Array.from({ length: CALCULATION_LIMITS.maxHoldingLots + 1 }, () => ({
        remainingQuantityDecimal: "1",
        remainingBasisDecimal: "1",
      })),
    ),
    { status: "unavailable", reason: "too_many_lots" },
  );

  const missingPrevious = calculateSingleDateHolding({
    quantityDecimal: "10",
    priceDecimal: "20",
    previousPriceDecimal: null,
    openBasisDecimal: "0",
    realisedGainDecimal: null,
  });
  assert.deepEqual(missingPrevious.previousNativeMarketValue, {
    status: "unavailable",
    reason: "missing_previous_price",
  });
  assert.deepEqual(missingPrevious.unrealisedPercent, {
    status: "unavailable",
    reason: "zero_basis",
  });
});
