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
  selectionState: "current",
  quality: "observed",
  fallback: false,
  selectionReason: "Same-date validated observation selected.",
};

export const usdAudPreviousFx: FxEvidence = {
  rateDecimal: "1.5",
  baseCurrencyCode: "USD",
  quoteCurrencyCode: "AUD",
  marketDate: "2026-08-02",
  observedAt: "2026-08-02T06:00:00Z",
  source: "provider",
  sourceId: "yahoo-compatible",
  selectionState: "current",
  quality: "observed",
  fallback: false,
  selectionReason: "Comparable prior-date observation selected.",
};

export const explicitTransactionFx: FxEvidence = {
  rateDecimal: "1.55",
  baseCurrencyCode: "USD",
  quoteCurrencyCode: "AUD",
  marketDate: "2026-07-15",
  observedAt: "2026-07-15T01:23:45Z",
  source: "transaction",
  sourceId: "transaction-1",
  selectionState: "current",
  quality: "transaction",
  fallback: false,
  selectionReason: "Explicit transaction FX fact selected.",
};

export const audUsdInverseFx: FxEvidence = {
  rateDecimal: "0.5",
  baseCurrencyCode: "AUD",
  quoteCurrencyCode: "USD",
  marketDate: "2026-08-03",
  observedAt: "2026-08-03T06:00:00Z",
  source: "provider",
  sourceId: "inverse-fixture",
  selectionState: "current",
  quality: "observed",
  fallback: false,
  selectionReason: "Same-date inverse observation selected.",
};

export const usdAudFallbackFx: FxEvidence = {
  ...usdAudCurrentFx,
  rateDecimal: "1.58",
  marketDate: "2026-08-01",
  observedAt: "2026-08-01T06:00:00Z",
  selectionState: "fallback",
  fallback: true,
  selectionReason:
    "The latest validated prior-session observation was selected.",
};

export const usdAudStaleFx: FxEvidence = {
  ...usdAudCurrentFx,
  rateDecimal: "1.57",
  marketDate: "2026-07-25",
  observedAt: "2026-07-25T06:00:00Z",
  selectionState: "stale",
  quality: "stale_candidate",
  fallback: true,
  selectionReason: "The last valid rate exceeds the freshness threshold.",
};
