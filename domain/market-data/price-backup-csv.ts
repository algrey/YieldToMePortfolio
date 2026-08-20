// MKT-008: the "Historical Data" backup export/re-import format -- a
// SEPARATE, self-describing CSV shape from both the ledger CSV
// (`domain/imports/strict-versioned-parser.ts`) and the single-security
// Intelligent Investor shape (`price-csv.ts`). Every row carries its own
// `format_version` (this task's ruling: "include a format-version
// header row/column" -- a per-row column is simpler to validate than a
// bespoke leading comment line, and keeps this module's parser a plain CSV
// reader) plus the FULL provenance a lossless round trip needs: provider,
// symbol/exchange evidence, currency, market date, price, observation
// instant, and quote metadata (interval/quality/adjustment state/delayed
// minutes) -- everything `db/repositories/price-uploads.ts`'s
// `loadOwnerPriceExportRows` already reads out of `price_observations` +
// `security_provider_mappings`.
//
// Deliberately PLAIN comma-split, no RFC4180 quote-escaping: every field
// this format ever writes is a constrained token (a provider id, an ASX-
// style ticker/exchange code, an ISO date/instant, a decimal string) except
// `source_label`, which this module's own serializer sanitizes (strips
// commas/CR/LF) before writing -- so a comma can never legitimately appear
// inside any field this app itself produces, and a plain split is lossless
// for it. A hostile/hand-edited file with an embedded comma in a text
// field simply produces a MALFORMED row (extra columns shift every field
// right, which then fails a downstream typed check) rather than a security
// issue -- fail-closed, per this format's own honesty rules.

export const PRICE_BACKUP_FORMAT_VERSION = "yieldtome-price-backup-v1";

const HEADER = [
  "format_version",
  "provider_id",
  "source_label",
  "provider_symbol",
  "provider_exchange",
  "currency_code",
  "market_date",
  "price_decimal",
  "observation_at",
  "market_timezone",
  "interval",
  "quality",
  "adjustment_state",
  "delayed_minutes",
] as const;

export type PriceBackupExportRow = Readonly<{
  providerId: string;
  sourceLabel: string;
  providerSymbol: string;
  providerExchange: string;
  currencyCode: string;
  marketDate: string;
  priceDecimal: string;
  observationAt: string;
  marketTimezone: string;
  interval: string;
  quality: string;
  adjustmentState: string;
  delayedMinutes: number | null;
}>;

function sanitizeField(value: string): string {
  return value.replaceAll(/[,\r\n]/g, " ").trim();
}

export function formatPriceBackupCsv(
  rows: readonly PriceBackupExportRow[],
): string {
  const lines = [HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        PRICE_BACKUP_FORMAT_VERSION,
        sanitizeField(row.providerId),
        sanitizeField(row.sourceLabel),
        sanitizeField(row.providerSymbol),
        sanitizeField(row.providerExchange),
        sanitizeField(row.currencyCode),
        row.marketDate,
        row.priceDecimal,
        row.observationAt,
        sanitizeField(row.marketTimezone),
        row.interval,
        row.quality,
        row.adjustmentState,
        row.delayedMinutes === null ? "" : String(row.delayedMinutes),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export type PriceBackupDataRow = Readonly<{
  physicalRowNumber: number;
  providerId: string;
  sourceLabel: string;
  providerSymbol: string;
  providerExchange: string;
  currencyCode: string;
  marketDate: string;
  priceDecimal: string;
  observationAt: string;
  marketTimezone: string;
  interval: "eod" | "delayed" | "intraday";
  quality: "observed" | "corrected" | "indicative" | "stale_candidate";
  adjustmentState: "raw" | "split_adjusted" | "total_return_adjusted";
  delayedMinutes: number | null;
}>;

export type PriceBackupMalformedReason =
  | "wrong_column_count"
  | "unsupported_format_version"
  | "unknown_provider"
  | "invalid_symbol_or_exchange"
  | "invalid_currency"
  | "invalid_date"
  | "invalid_price"
  | "invalid_observation_at"
  | "invalid_quote_metadata";

export type PriceBackupMalformedRow = Readonly<{
  physicalRowNumber: number;
  reason: PriceBackupMalformedReason;
}>;

export type ParsePriceBackupResult =
  | {
      ok: true;
      rows: PriceBackupDataRow[];
      malformed: PriceBackupMalformedRow[];
    }
  | {
      ok: false;
      code:
        | "EMPTY_FILE"
        | "DECODE_FAILED"
        | "MISSING_HEADER"
        | "BYTE_LIMIT_EXCEEDED"
        | "ROW_LIMIT_EXCEEDED";
      message: string;
    };

export type PriceBackupLimits = Readonly<{ maxBytes: number; maxRows: number }>;

// A full-portfolio backup can span many securities' full histories --
// generous relative to the single-security caps (`price-csv.ts`), but still
// bounded (this task's caps-documented precedent).
export const DEFAULT_PRICE_BACKUP_LIMITS: PriceBackupLimits = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxRows: 500_000,
});

// Only providers this deployment can honestly have exported -- see this
// module's header comment. A future new provider extends this list (never
// a schema change), keeping the "future sources fit" ruling literal.
const KNOWN_PROVIDER_IDS = new Set(["sharesight", "owner-import"]);
const INTERVALS = new Set(["eod", "delayed", "intraday"]);
const QUALITIES = new Set([
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
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && /[1-9]/.test(value);
}

function isValidMarketDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

function isIsoInstant(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  );
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function parsePriceBackupCsv(
  bytes: Uint8Array,
  limits: PriceBackupLimits = DEFAULT_PRICE_BACKUP_LIMITS,
): ParsePriceBackupResult {
  if (bytes.byteLength === 0) {
    return { ok: false, code: "EMPTY_FILE", message: "The file is empty." };
  }
  if (bytes.byteLength > limits.maxBytes) {
    return {
      ok: false,
      code: "BYTE_LIMIT_EXCEEDED",
      message: "The file exceeded the configured size limit.",
    };
  }
  const decoded = decodeUtf8(bytes);
  if (decoded === null) {
    return {
      ok: false,
      code: "DECODE_FAILED",
      message: "The file is not valid UTF-8 text.",
    };
  }
  const text = stripBom(decoded);
  const lines = text.split(/\r\n|\r|\n/).filter((line, index, all) => {
    return !(index === all.length - 1 && line.trim().length === 0);
  });
  if (lines.length === 0 || lines[0]!.trim().length === 0) {
    return {
      ok: false,
      code: "MISSING_HEADER",
      message: "The file has no header row.",
    };
  }
  const headerColumns = lines[0]!.split(",").map((column) => column.trim());
  if (
    headerColumns.length !== HEADER.length ||
    headerColumns.some((column, index) => column !== HEADER[index])
  ) {
    return {
      ok: false,
      code: "MISSING_HEADER",
      message: "The file's header does not match the backup format.",
    };
  }
  if (lines.length - 1 > limits.maxRows) {
    return {
      ok: false,
      code: "ROW_LIMIT_EXCEEDED",
      message: "The file exceeded the configured row limit.",
    };
  }

  const rows: PriceBackupDataRow[] = [];
  const malformed: PriceBackupMalformedRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const physicalRowNumber = index + 1;
    if (line.trim().length === 0) continue;
    const columns = line.split(",").map((column) => column.trim());
    if (columns.length !== HEADER.length) {
      malformed.push({ physicalRowNumber, reason: "wrong_column_count" });
      continue;
    }
    const [
      formatVersion,
      providerId,
      sourceLabel,
      providerSymbol,
      providerExchange,
      currencyCode,
      marketDate,
      priceDecimal,
      observationAt,
      marketTimezone,
      interval,
      quality,
      adjustmentState,
      delayedMinutesRaw,
    ] = columns;
    if (formatVersion !== PRICE_BACKUP_FORMAT_VERSION) {
      malformed.push({
        physicalRowNumber,
        reason: "unsupported_format_version",
      });
      continue;
    }
    if (!KNOWN_PROVIDER_IDS.has(providerId!)) {
      malformed.push({ physicalRowNumber, reason: "unknown_provider" });
      continue;
    }
    if (!providerSymbol || !providerExchange) {
      malformed.push({
        physicalRowNumber,
        reason: "invalid_symbol_or_exchange",
      });
      continue;
    }
    if (!CURRENCY_PATTERN.test(currencyCode!)) {
      malformed.push({ physicalRowNumber, reason: "invalid_currency" });
      continue;
    }
    if (!isValidMarketDate(marketDate!)) {
      malformed.push({ physicalRowNumber, reason: "invalid_date" });
      continue;
    }
    if (!isPositiveDecimal(priceDecimal!)) {
      malformed.push({ physicalRowNumber, reason: "invalid_price" });
      continue;
    }
    if (!isIsoInstant(observationAt!)) {
      malformed.push({ physicalRowNumber, reason: "invalid_observation_at" });
      continue;
    }
    if (
      !marketTimezone ||
      !INTERVALS.has(interval!) ||
      !QUALITIES.has(quality!) ||
      !ADJUSTMENT_STATES.has(adjustmentState!)
    ) {
      malformed.push({ physicalRowNumber, reason: "invalid_quote_metadata" });
      continue;
    }
    let delayedMinutes: number | null = null;
    if (delayedMinutesRaw !== "") {
      const parsed = Number(delayedMinutesRaw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        malformed.push({ physicalRowNumber, reason: "invalid_quote_metadata" });
        continue;
      }
      delayedMinutes = parsed;
    }
    rows.push({
      physicalRowNumber,
      providerId: providerId!,
      sourceLabel: sourceLabel!,
      providerSymbol: providerSymbol!,
      providerExchange: providerExchange!,
      currencyCode: currencyCode!,
      marketDate: marketDate!,
      priceDecimal: priceDecimal!,
      observationAt: observationAt!,
      marketTimezone: marketTimezone!,
      interval: interval as PriceBackupDataRow["interval"],
      quality: quality as PriceBackupDataRow["quality"],
      adjustmentState: adjustmentState as PriceBackupDataRow["adjustmentState"],
      delayedMinutes,
    });
  }
  return { ok: true, rows, malformed };
}
