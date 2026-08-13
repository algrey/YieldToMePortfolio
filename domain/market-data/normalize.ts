import type {
  DividendEventInput,
  FxObservation,
  MarketDataResult,
  NormalizationContext,
  ObservationInterval,
  PriceObservation,
  ProviderDataQuality,
  SplitEventInput,
} from "./contracts.ts";

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;
const INTERVALS = new Set<ObservationInterval>(["eod", "delayed", "intraday"]);
const QUALITIES = new Set<ProviderDataQuality>([
  "observed",
  "corrected",
  "indicative",
  "stale_candidate",
]);
const ADJUSTMENT_STATES = new Set([
  "raw",
  "split_adjusted",
  "total_return_adjusted",
]);

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null
    ? (value as RecordValue)
    : null;
}

function requiredString(record: RecordValue, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalString(record: RecordValue, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) {
    return null;
  }

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalStringIsValid(record: RecordValue, field: string): boolean {
  const value = record[field];
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

function isIsoInstant(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  );
}

function isMarketDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

function isDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value);
}

function isPositiveDecimal(value: string): boolean {
  return isDecimal(value) && /[1-9]/.test(value.replaceAll(".", ""));
}

function invalid(message: string): MarketDataResult<never> {
  return {
    ok: false,
    error: { kind: "invalid_response", message, retryable: false },
  };
}

function parseCommonObservationFields(record: RecordValue): MarketDataResult<{
  interval: ObservationInterval;
  quality: ProviderDataQuality;
}> {
  const interval = requiredString(record, "interval");
  const quality = requiredString(record, "quality");
  if (!interval || !INTERVALS.has(interval as ObservationInterval)) {
    return invalid("Observation interval is unsupported.");
  }
  if (!quality || !QUALITIES.has(quality as ProviderDataQuality)) {
    return invalid("Provider quality is unsupported.");
  }

  return {
    ok: true,
    value: {
      interval: interval as ObservationInterval,
      quality: quality as ProviderDataQuality,
    },
  };
}

function parseDelayedMinutes(
  record: RecordValue,
): number | null | MarketDataResult<never> {
  const value = record.delayedMinutes;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("Delayed minutes must be a non-negative integer.");
  }
  return value;
}

export function normalizePriceObservation(
  input: unknown,
  context: NormalizationContext,
): MarketDataResult<PriceObservation> {
  const record = asRecord(input);
  if (!record || !context.mappingId || !context.securityId) {
    return invalid("Price observation or mapping context is incomplete.");
  }

  const common = parseCommonObservationFields(record);
  if (!common.ok) {
    return common;
  }
  const observationAt = requiredString(record, "observationAt");
  const marketDate = requiredString(record, "marketDate");
  const marketTimezone = requiredString(record, "marketTimezone");
  const currencyCode = requiredString(record, "currencyCode");
  const closeDecimal = requiredString(record, "closeDecimal");
  const previousCloseDecimal = optionalString(record, "previousCloseDecimal");
  const adjustmentState = requiredString(record, "adjustmentState");
  const adjustmentFactor = optionalString(record, "adjustmentFactor");
  if (
    !observationAt ||
    !isIsoInstant(observationAt) ||
    !marketDate ||
    !isMarketDate(marketDate) ||
    !marketTimezone ||
    !currencyCode ||
    !closeDecimal ||
    !isPositiveDecimal(closeDecimal) ||
    (previousCloseDecimal !== null &&
      !isPositiveDecimal(previousCloseDecimal)) ||
    !adjustmentState ||
    !ADJUSTMENT_STATES.has(adjustmentState) ||
    (adjustmentFactor !== null && !isPositiveDecimal(adjustmentFactor)) ||
    !optionalStringIsValid(record, "previousCloseDecimal") ||
    !optionalStringIsValid(record, "adjustmentFactor") ||
    !optionalStringIsValid(record, "providerRevisionId") ||
    !optionalStringIsValid(record, "payloadSha256") ||
    !isIsoInstant(context.ingestedAt)
  ) {
    return invalid(
      "Price observation contains malformed provenance or value fields.",
    );
  }

  const delayedMinutes = parseDelayedMinutes(record);
  if (typeof delayedMinutes !== "number" && delayedMinutes !== null) {
    return delayedMinutes;
  }

  return {
    ok: true,
    value: {
      kind: "price",
      providerId: context.providerId,
      providerRevisionId: optionalString(record, "providerRevisionId"),
      mappingId: context.mappingId,
      securityId: context.securityId,
      scope: context.scope,
      interval: common.value.interval,
      observationAt,
      marketDate,
      marketTimezone,
      currencyCode,
      closeDecimal,
      previousCloseDecimal,
      adjustmentState: adjustmentState as PriceObservation["adjustmentState"],
      adjustmentFactor,
      quality: common.value.quality,
      delayedMinutes,
      ingestedAt: context.ingestedAt,
      payloadSha256: optionalString(record, "payloadSha256"),
    },
  };
}

export function normalizeFxObservation(
  input: unknown,
  context: NormalizationContext,
): MarketDataResult<FxObservation> {
  const record = asRecord(input);
  if (!record) {
    return invalid("FX observation is not an object.");
  }

  const common = parseCommonObservationFields(record);
  if (!common.ok) {
    return common;
  }
  const baseCurrencyCode = requiredString(record, "baseCurrencyCode");
  const quoteCurrencyCode = requiredString(record, "quoteCurrencyCode");
  const rateDecimal = requiredString(record, "rateDecimal");
  const observedAt = requiredString(record, "observedAt");
  const marketDate = requiredString(record, "marketDate");
  if (
    !baseCurrencyCode ||
    !quoteCurrencyCode ||
    baseCurrencyCode === quoteCurrencyCode ||
    !rateDecimal ||
    !isPositiveDecimal(rateDecimal) ||
    !observedAt ||
    !isIsoInstant(observedAt) ||
    !marketDate ||
    !isMarketDate(marketDate) ||
    !optionalStringIsValid(record, "providerRevisionId") ||
    !optionalStringIsValid(record, "payloadSha256") ||
    !isIsoInstant(context.ingestedAt)
  ) {
    return invalid(
      "FX observation contains malformed direction, date, or rate.",
    );
  }

  const delayedMinutes = parseDelayedMinutes(record);
  if (typeof delayedMinutes !== "number" && delayedMinutes !== null) {
    return delayedMinutes;
  }

  return {
    ok: true,
    value: {
      kind: "fx",
      providerId: context.providerId,
      providerRevisionId: optionalString(record, "providerRevisionId"),
      scope: context.scope,
      baseCurrencyCode,
      quoteCurrencyCode,
      rateDecimal,
      interval: common.value.interval,
      observedAt,
      marketDate,
      quality: common.value.quality,
      delayedMinutes,
      ingestedAt: context.ingestedAt,
      payloadSha256: optionalString(record, "payloadSha256"),
    },
  };
}

/**
 * Validates one provider dividend event as `unknown` at the boundary,
 * mirroring `normalizePriceObservation`/`normalizeFxObservation` above
 * (MKT-005). `context.securityId` is required -- there is no per-observation
 * mapping/security context to fall back on the way price/FX observations
 * have one already resolved via the request.
 */
export function normalizeDividendEventInput(
  input: unknown,
  context: NormalizationContext,
): MarketDataResult<DividendEventInput> {
  const record = asRecord(input);
  if (!record || !context.securityId) {
    return invalid("Dividend event or security context is incomplete.");
  }

  const exDate = requiredString(record, "exDate");
  const currencyCode = requiredString(record, "currencyCode");
  const amountDecimal = requiredString(record, "amountDecimal");
  const paymentDate = optionalString(record, "paymentDate");
  if (
    !exDate ||
    !isMarketDate(exDate) ||
    !currencyCode ||
    !amountDecimal ||
    !isPositiveDecimal(amountDecimal) ||
    !optionalStringIsValid(record, "paymentDate") ||
    (paymentDate !== null && !isMarketDate(paymentDate))
  ) {
    return invalid(
      "Dividend event contains a malformed date, currency, or amount.",
    );
  }

  return {
    ok: true,
    value: {
      securityId: context.securityId,
      exDate,
      paymentDate,
      currencyCode,
      amountDecimal,
    },
  };
}

/**
 * Validates one provider split event as `unknown` at the boundary; see
 * `normalizeDividendEventInput` above for the pattern this mirrors.
 */
export function normalizeSplitEventInput(
  input: unknown,
  context: NormalizationContext,
): MarketDataResult<SplitEventInput> {
  const record = asRecord(input);
  if (!record || !context.securityId) {
    return invalid("Split event or security context is incomplete.");
  }

  const effectiveDate = requiredString(record, "effectiveDate");
  const numeratorDecimal = requiredString(record, "numeratorDecimal");
  const denominatorDecimal = requiredString(record, "denominatorDecimal");
  if (
    !effectiveDate ||
    !isMarketDate(effectiveDate) ||
    !numeratorDecimal ||
    !isPositiveDecimal(numeratorDecimal) ||
    !denominatorDecimal ||
    !isPositiveDecimal(denominatorDecimal)
  ) {
    return invalid("Split event contains a malformed date or split ratio.");
  }

  return {
    ok: true,
    value: {
      securityId: context.securityId,
      effectiveDate,
      numeratorDecimal,
      denominatorDecimal,
    },
  };
}
