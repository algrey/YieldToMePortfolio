import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateFifoSale,
  applyFifoSplit,
  createFifoLot,
  rebuildFifo,
  type FifoLot,
  type FifoSaleInput,
} from "../domain/ledger/index.ts";

function lot(
  id: string,
  acquiredAt: string,
  openingTransactionId: string,
  quantity: string,
  cost: string | null,
  fee = "0",
  tax = "0",
  basisStatus?: "complete" | "incomplete_fx" | "incomplete_basis",
): FifoLot {
  const result = createFifoLot({
    id,
    acquiredAt,
    openingTransactionId,
    quantityDecimal: quantity,
    costBasisBaseDecimal: cost,
    acquisitionFeeBaseDecimal: cost === null ? null : fee,
    acquisitionTaxBaseDecimal: cost === null ? null : tax,
    basisStatus,
  });
  assert.ok(result);
  return result;
}

function sale(overrides: Partial<FifoSaleInput> = {}): FifoSaleInput {
  return {
    transactionId: "sale-1",
    quantityDecimal: "12",
    netProceedsBaseDecimal: "354",
    feeBaseDecimal: "6",
    taxBaseDecimal: "0",
    ...overrides,
  };
}

test("FIFO matches partial and multi-lot sales with acquisition and sale fees", () => {
  const result = allocateFifoSale(
    [
      lot("lot-1", "2026-01-01T00:00:00Z", "buy-1", "10", "200", "10"),
      lot("lot-2", "2026-01-02T00:00:00Z", "buy-2", "5", "120", "5"),
    ],
    sale(),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(
    result.allocations.map((allocation) => ({
      lotId: allocation.lotId,
      quantity: allocation.quantityDecimal,
      basis: allocation.baseBasisDecimal,
      proceeds: allocation.netProceedsBaseDecimal,
      fee: allocation.feeBaseDecimal,
      gain: allocation.baseRealisedGainDecimal,
    })),
    [
      {
        lotId: "lot-1",
        quantity: "10",
        basis: "210",
        proceeds: "295",
        fee: "5",
        gain: "80",
      },
      {
        lotId: "lot-2",
        quantity: "2",
        basis: "50",
        proceeds: "59",
        fee: "1",
        gain: "8",
      },
    ],
  );
  assert.equal(result.remainingLots[0]?.openQuantityDecimal, "3");
  assert.equal(result.remainingLots[0]?.remainingBasisBaseDecimal, "75");
});

test("equal acquisition timestamps use stable transaction and lot ordering", () => {
  const result = allocateFifoSale(
    [
      lot("lot-z", "2026-01-01T00:00:00Z", "buy-z", "1", "10"),
      lot("lot-a", "2026-01-01T00:00:00Z", "buy-a", "1", "20"),
    ],
    sale({
      transactionId: "sale-equal",
      quantityDecimal: "1",
      netProceedsBaseDecimal: "30",
      feeBaseDecimal: "0",
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.allocations[0]?.lotId, "lot-a");
  }
});

test("rounding assigns the exact residual to the final allocation", () => {
  const result = allocateFifoSale(
    [
      lot("lot-1", "2026-01-01", "buy-1", "1", "100"),
      lot("lot-2", "2026-01-02", "buy-2", "1", "100"),
      lot("lot-3", "2026-01-03", "buy-3", "1", "100"),
    ],
    sale({
      transactionId: "sale-rounding",
      quantityDecimal: "3",
      netProceedsBaseDecimal: "100",
      feeBaseDecimal: "1",
    }),
    2,
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.allocations.map((allocation) => [
        allocation.netProceedsBaseDecimal,
        allocation.feeBaseDecimal,
      ]),
      [
        ["33.33", "0.33"],
        ["33.33", "0.33"],
        ["33.34", "0.34"],
      ],
    );
  }
});

test("incomplete FX or basis remains explicit and never becomes zero", () => {
  const result = allocateFifoSale(
    [
      lot(
        "lot-incomplete",
        "2026-01-01",
        "buy-1",
        "2",
        null,
        "0",
        "0",
        "incomplete_fx",
      ),
    ],
    sale({
      quantityDecimal: "1",
      netProceedsBaseDecimal: null,
      feeBaseDecimal: null,
      proceedsStatus: "incomplete_fx",
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.allocations[0]?.baseBasisDecimal, null);
    assert.equal(result.allocations[0]?.netProceedsBaseDecimal, null);
    assert.equal(result.allocations[0]?.baseRealisedGainDecimal, null);
    assert.equal(result.allocations[0]?.basisStatus, "incomplete_fx");
  }
});

test("oversell returns an explicit unmatched remainder", () => {
  const result = allocateFifoSale(
    [lot("lot-1", "2026-01-01", "buy-1", "2", "20")],
    sale({ quantityDecimal: "3" }),
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "oversell",
    allocations: [],
    remainingLots: [lot("lot-1", "2026-01-01", "buy-1", "2", "20")],
    matchedQuantityDecimal: "2",
    unmatchedQuantityDecimal: "1",
  });
});

test("splits preserve total basis and rebuild reversal is deterministic", () => {
  const original = lot("lot-1", "2026-01-01", "buy-1", "10", "100");
  const split = applyFifoSplit([original], {
    numeratorDecimal: "2",
    denominatorDecimal: "1",
  });
  assert.equal(split?.[0]?.openQuantityDecimal, "20");
  assert.equal(split?.[0]?.remainingBasisBaseDecimal, "100");

  const events = [
    {
      kind: "buy" as const,
      eventId: "buy-1",
      effectiveAt: "2026-01-01T00:00:00Z",
      lot: {
        id: "lot-1",
        acquiredAt: "2026-01-01T00:00:00Z",
        openingTransactionId: "buy-1",
        quantityDecimal: "10",
        costBasisBaseDecimal: "100",
        acquisitionFeeBaseDecimal: "0",
        acquisitionTaxBaseDecimal: "0",
      },
    },
    {
      kind: "sell" as const,
      eventId: "sale-1",
      effectiveAt: "2026-01-02T00:00:00Z",
      sale: sale({
        quantityDecimal: "2",
        netProceedsBaseDecimal: "30",
        feeBaseDecimal: "0",
      }),
    },
    {
      kind: "reversal" as const,
      eventId: "reversal-1",
      effectiveAt: "2026-01-03T00:00:00Z",
      reversesEventId: "sale-1",
    },
  ];
  const rebuilt = rebuildFifo(events);
  const withoutSale = rebuildFifo([events[0]!]);
  assert.deepEqual(rebuilt, withoutSale);
});
