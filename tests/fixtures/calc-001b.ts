import type {
  CalculationValue,
  FxEvidence,
} from "../../domain/calculations/index.ts";

export const available = (valueDecimal: string): CalculationValue => ({
  status: "available",
  valueDecimal,
});

export const unavailable = (
  reason: Extract<CalculationValue, { status: "unavailable" }>["reason"],
): CalculationValue => ({ status: "unavailable", reason });

export const usdAudCurrentFx: FxEvidence = {
  rateDecimal: "1.6",
  baseCurrencyCode: "USD",
  quoteCurrencyCode: "AUD",
  marketDate: "2026-08-03",
  observedAt: "2026-08-03T06:00:00Z",
  source: "provider",
  sourceId: "yahoo-compatible",
};

export const usdAudPreviousFx: FxEvidence = {
  rateDecimal: "1.5",
  baseCurrencyCode: "USD",
  quoteCurrencyCode: "AUD",
  marketDate: "2026-08-02",
  observedAt: "2026-08-02T06:00:00Z",
  source: "provider",
  sourceId: "yahoo-compatible",
};

export const explicitTransactionFx: FxEvidence = {
  rateDecimal: "1.55",
  baseCurrencyCode: "USD",
  quoteCurrencyCode: "AUD",
  marketDate: "2026-07-15",
  observedAt: "2026-07-15T01:23:45Z",
  source: "transaction",
  sourceId: "transaction-1",
};

export const audUsdInverseFx: FxEvidence = {
  rateDecimal: "0.5",
  baseCurrencyCode: "AUD",
  quoteCurrencyCode: "USD",
  marketDate: "2026-08-03",
  observedAt: "2026-08-03T06:00:00Z",
  source: "provider",
  sourceId: "inverse-fixture",
};
