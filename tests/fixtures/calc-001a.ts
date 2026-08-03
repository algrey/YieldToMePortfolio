export const fifoHoldingFixture = {
  lots: [
    {
      id: "lot-1",
      acquiredAt: "2026-01-01T00:00:00Z",
      openingTransactionId: "buy-1",
      quantityDecimal: "10",
      costBasisBaseDecimal: "200",
      acquisitionFeeBaseDecimal: "10",
      acquisitionTaxBaseDecimal: "0",
    },
    {
      id: "lot-2",
      acquiredAt: "2026-01-02T00:00:00Z",
      openingTransactionId: "buy-2",
      quantityDecimal: "5",
      costBasisBaseDecimal: "120",
      acquisitionFeeBaseDecimal: "5",
      acquisitionTaxBaseDecimal: "0",
    },
  ],
  sale: {
    transactionId: "sale-1",
    quantityDecimal: "12",
    netProceedsBaseDecimal: "360",
    feeBaseDecimal: "6",
    taxBaseDecimal: "0",
  },
  priceDecimal: "30",
  previousPriceDecimal: "25",
} as const;

export const expectedFifoHoldingResult = {
  quantity: { status: "available", valueDecimal: "3" },
  nativeMarketValue: { status: "available", valueDecimal: "90" },
  previousNativeMarketValue: { status: "available", valueDecimal: "75" },
  dailyMovement: { status: "available", valueDecimal: "15" },
  openBasis: { status: "available", valueDecimal: "75" },
  unrealisedGain: { status: "available", valueDecimal: "15" },
  unrealisedPercent: { status: "available", valueDecimal: "20" },
  realisedGain: { status: "available", valueDecimal: "94" },
  totalGain: { status: "available", valueDecimal: "109" },
  totalPercent: { status: "available", valueDecimal: "145.33" },
} as const;
