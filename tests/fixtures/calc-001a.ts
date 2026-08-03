export const fifoHoldingFixture = {
  quantityDecimal: "12",
  priceDecimal: "30",
  previousPriceDecimal: "25",
  openBasisDecimal: "260",
  realisedGainDecimal: "94",
} as const;

export const expectedFifoHoldingResult = {
  quantity: { status: "available", valueDecimal: "12" },
  nativeMarketValue: { status: "available", valueDecimal: "360" },
  previousNativeMarketValue: { status: "available", valueDecimal: "300" },
  dailyMovement: { status: "available", valueDecimal: "60" },
  openBasis: { status: "available", valueDecimal: "260" },
  unrealisedGain: { status: "available", valueDecimal: "100" },
  unrealisedPercent: { status: "available", valueDecimal: "38.46" },
  realisedGain: { status: "available", valueDecimal: "94" },
  totalGain: { status: "available", valueDecimal: "194" },
  totalPercent: { status: "available", valueDecimal: "74.62" },
} as const;
