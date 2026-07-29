import type {
  FxObservation,
  MarketDataResult,
  NormalizationContext,
  ObservationInterval,
  PriceObservation,
  ProviderDataQuality,
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

function isIsoInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && value.includes("T");
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
