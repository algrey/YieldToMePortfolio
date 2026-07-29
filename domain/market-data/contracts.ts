export type ObservationInterval = "eod" | "delayed" | "intraday";

export type ProviderDataQuality =
  "observed" | "corrected" | "indicative" | "stale_candidate";

export type ObservationScope =
  { kind: "deployment"; userId: null } | { kind: "user"; userId: string };

export type ProviderCapabilities = {
  exchanges: string[];
  intervals: ObservationInterval[];
  supportsRawPrices: boolean;
  supportsAdjustedPrices: boolean;
  supportsFx: boolean;
  supportsDividends: boolean;
  supportsSplits: boolean;
  supportsFundamentals: boolean;
  historicalStart?: string;
  delayedMinutes?: number;
};

export type PriceObservation = {
  kind: "price";
  providerId: string;
  providerRevisionId: string | null;
  mappingId: string;
  securityId: string;
  scope: ObservationScope;
  interval: ObservationInterval;
  observationAt: string;
  marketDate: string;
  marketTimezone: string;
  currencyCode: string;
  closeDecimal: string;
  previousCloseDecimal: string | null;
  adjustmentState: "raw" | "split_adjusted" | "total_return_adjusted";
  adjustmentFactor: string | null;
  quality: ProviderDataQuality;
  delayedMinutes: number | null;
  ingestedAt: string;
  payloadSha256: string | null;
};

export type FxObservation = {
  kind: "fx";
  providerId: string;
  providerRevisionId: string | null;
  scope: ObservationScope;
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  rateDecimal: string;
  interval: ObservationInterval;
  observedAt: string;
  marketDate: string;
  quality: ProviderDataQuality;
  delayedMinutes: number | null;
  ingestedAt: string;
  payloadSha256: string | null;
};

export type ManualOverride = {
  kind: "manual_override";
  userId: string;
  portfolioId: string | null;
  securityId: string | null;
  type: "price" | "fx_rate" | "security_mapping" | "transaction_fx";
  targetKey: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  valueJson: string;
  reason: string;
  status: "active" | "superseded" | "revoked";
  supersedesOverrideId: string | null;
  createdAt: string;
};

export type SecurityQuery = {
  text: string;
  exchangeId?: string;
  currencyCode?: string;
};

export type DailyPriceRequest = {
  mappingId: string;
  securityId: string;
  from: string;
  to: string;
  scope: ObservationScope;
};

export type LatestRequest = {
  mappingId: string;
  securityId: string;
  scope: ObservationScope;
};

export type FxRequest = {
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  from: string;
  to: string;
  scope: ObservationScope;
};

export type DividendRequest = {
  securityId: string;
  from: string;
  to: string;
  scope: ObservationScope;
};

export type SplitRequest = {
  securityId: string;
  from: string;
  to: string;
  scope: ObservationScope;
};

export type FundamentalRequest = {
  securityId: string;
  asOf: string;
  scope: ObservationScope;
};

export type SecurityCandidate = {
  securityId: string | null;
  mappingId: string | null;
  symbol: string;
  exchangeId: string | null;
  currencyCode: string | null;
  name: string;
  confidence: "low" | "medium" | "high";
};

export type DividendEventInput = {
  securityId: string;
  exDate: string;
  currencyCode: string;
  amountDecimal: string;
};

export type SplitEventInput = {
  securityId: string;
  effectiveDate: string;
  numeratorDecimal: string;
  denominatorDecimal: string;
};

export type FundamentalSnapshot = {
  securityId: string;
  asOf: string;
  values: Record<string, string>;
};

export type MarketDataErrorKind =
  | "authentication"
  | "entitlement"
  | "rate_limit"
  | "unavailable_capability"
  | "symbol_not_found"
  | "invalid_response"
  | "timeout"
  | "transient_upstream";

export type MarketDataError = {
  kind: MarketDataErrorKind;
  message: string;
  retryable: boolean;
};

export type MarketDataResult<T> =
  { ok: true; value: T } | { ok: false; error: MarketDataError };

export type MarketDataProvider = {
  capabilities(): ProviderCapabilities;
  searchSecurities(
    query: SecurityQuery,
  ): Promise<MarketDataResult<SecurityCandidate[]>>;
  getDailyPrices(
    request: DailyPriceRequest,
  ): Promise<MarketDataResult<PriceObservation[]>>;
  getLatestObservation(
    request: LatestRequest,
  ): Promise<MarketDataResult<PriceObservation | null>>;
  getFxRates(request: FxRequest): Promise<MarketDataResult<FxObservation[]>>;
  getDividendEvents(
    request: DividendRequest,
  ): Promise<MarketDataResult<DividendEventInput[]>>;
  getSplitEvents(
    request: SplitRequest,
  ): Promise<MarketDataResult<SplitEventInput[]>>;
  getFundamentals?(
    request: FundamentalRequest,
  ): Promise<MarketDataResult<FundamentalSnapshot | null>>;
};

export type NormalizationContext = {
  providerId: string;
  mappingId?: string;
  securityId?: string;
  scope: ObservationScope;
  ingestedAt: string;
};
