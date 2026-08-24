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
//
// Text decoding shares `./text-encoding.ts`'s UTF-8/UTF-16 detection with
// `price-csv.ts` (own exports are always UTF-8, but a backup file re-saved
// by a spreadsheet application before re-import could plausibly pick up
// the same UTF-16 re-encoding that module's header comment documents --
// this is free correctness from not duplicating the decode logic).

import { decodeText, stripBom } from "./text-encoding.ts";
import { isPositiveDecimal, isValidMarketDate } from "./price-value-grammar.ts";

export const PRICE_BACKUP_FORMAT_VERSION = "yieldtome-price-backup-v1";

// MKT-008/IMP-010A: the ONE `source_label` length convention this app uses
// for the historical-data import surface -- originally local to
// `app/price-upload-service.ts`'s `sanitizeSourceLabel` (the single-security
// form's batch-level label); moved here and re-exported so
// `validateUploadedPriceBackupRow` below can apply the SAME truncation to a
// backup row's per-row `sourceLabel` field (review B2 fix, 2026-08-25: that
// field was length-unbounded before this fix) without a second,
// independently-chosen number.
export const MAX_SOURCE_LABEL_LENGTH = 60;

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

/** Runtime enumeration of `PriceBackupMalformedReason`'s members -- the
 * SINGLE source of truth both `parsePriceBackupCsv`'s own classification
 * above and IMP-010A's `sanitizeUploadedMalformedByReason` below key off
 * (never a second, hand-maintained list that could silently drift from the
 * type union). */
export const PRICE_BACKUP_MALFORMED_REASONS: readonly PriceBackupMalformedReason[] =
  [
    "wrong_column_count",
    "unsupported_format_version",
    "unknown_provider",
    "invalid_symbol_or_exchange",
    "invalid_currency",
    "invalid_date",
    "invalid_price",
    "invalid_observation_at",
    "invalid_quote_metadata",
  ];

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
//
// Review B1 fix (BLOCKING, 2026-08-25): `maxRows` was previously 500,000 --
// arithmetically unreachable through IMP-010A's JSON upload payload
// (measured ~2.30x byte expansion per row vs. this file's own raw-CSV
// serialization, `tests/imp-010a.test.ts` pins the exact figure) even
// against the raised 64 MiB request-body ceiling
// (`app/price-upload-actions.ts`'s `MAX_BACKUP_REQUEST_BYTES`) --
// documenting it as achievable was false. 130,000 is the HONEST figure:
// comfortably under BOTH (a) the ~137,970 rows the 20 MiB `maxBytes` cap
// above can ever actually produce from a real export (typical per-row CSV
// bytes), and (b) the ~136,400 rows the 64 MiB server ceiling can accept
// even in the WORST case where every row hits this file's own per-field
// length bounds (`MAX_SOURCE_LABEL_LENGTH`, `DECIMAL_LIMITS.inputDigits`) --
// so this row-count check and the server's byte-ceiling check are
// consistent with each other under every input, not just the typical case.
export const DEFAULT_PRICE_BACKUP_LIMITS: PriceBackupLimits = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxRows: 130_000,
});

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

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

function isIsoInstant(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  );
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
      // Review B1 fix: names the actual configured limit and an action --
      // this check runs client-side (the browser calls this SAME function
      // before ever uploading), so a too-large backup is caught with an
      // actionable message before the network round trip, not as an
      // opaque 413 from the server.
      message: `The file exceeded the ${formatMiB(limits.maxBytes)} size limit. Split the backup into multiple files (e.g. by provider or date range) and re-import each.`,
    };
  }
  const decoded = decodeText(bytes);
  if (decoded === null) {
    return {
      ok: false,
      code: "DECODE_FAILED",
      message: "The file could not be decoded as UTF-8 or UTF-16 text.",
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
      // Review B1 fix: same actionable-before-upload rationale as the byte
      // check above.
      message: `The file exceeded the ${limits.maxRows.toLocaleString("en-US")}-row limit. Split the backup into multiple files (e.g. by provider or date range) and re-import each.`,
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

// ---------------------------------------------------------------------------
// IMP-010A: browser-parse/server-authority split -- see `price-csv.ts`'s own
// IMP-010A section header for the full rationale (identical split, applied
// to this backup format's richer per-row shape). `format_version` is NOT
// part of the uploaded-row shape below: the browser's own
// `parsePriceBackupCsv` already rejected any row whose version didn't match
// `PRICE_BACKUP_FORMAT_VERSION` before this payload was ever built, so a
// validated row carries no leftover need to restate it -- there is nothing
// downstream that reads a per-row format version off `PriceBackupDataRow`
// either (the export/round-trip write path always re-stamps the CURRENT
// constant, see `formatPriceBackupCsv` above).
// ---------------------------------------------------------------------------

export type PriceBackupUploadedRowInput = Readonly<{
  providerId: unknown;
  sourceLabel: unknown;
  providerSymbol: unknown;
  providerExchange: unknown;
  currencyCode: unknown;
  marketDate: unknown;
  priceDecimal: unknown;
  observationAt: unknown;
  marketTimezone: unknown;
  interval: unknown;
  quality: unknown;
  adjustmentState: unknown;
  delayedMinutes: unknown;
}>;

export type ValidateUploadedPriceBackupRowResult =
  | { ok: true; row: PriceBackupDataRow }
  | { ok: false; reason: PriceBackupMalformedReason };

/** Re-validates ONE row of an untrusted browser-uploaded backup payload,
 * field by field, using the SAME predicates/sets `parsePriceBackupCsv`
 * enforces on raw text above -- never a second definition. */
export function validateUploadedPriceBackupRow(
  physicalRowNumber: number,
  candidate: unknown,
): ValidateUploadedPriceBackupRowResult {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return { ok: false, reason: "wrong_column_count" };
  }
  const record = candidate as Record<string, unknown>;
  const {
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
    delayedMinutes,
  } = record;
  if (
    typeof providerId !== "string" ||
    typeof sourceLabel !== "string" ||
    typeof providerSymbol !== "string" ||
    typeof providerExchange !== "string" ||
    typeof currencyCode !== "string" ||
    typeof marketDate !== "string" ||
    typeof priceDecimal !== "string" ||
    typeof observationAt !== "string" ||
    typeof marketTimezone !== "string" ||
    typeof interval !== "string" ||
    typeof quality !== "string" ||
    typeof adjustmentState !== "string"
  ) {
    return { ok: false, reason: "wrong_column_count" };
  }
  if (!KNOWN_PROVIDER_IDS.has(providerId)) {
    return { ok: false, reason: "unknown_provider" };
  }
  if (!providerSymbol || !providerExchange) {
    return { ok: false, reason: "invalid_symbol_or_exchange" };
  }
  if (!CURRENCY_PATTERN.test(currencyCode)) {
    return { ok: false, reason: "invalid_currency" };
  }
  if (!isValidMarketDate(marketDate)) {
    return { ok: false, reason: "invalid_date" };
  }
  if (!isPositiveDecimal(priceDecimal)) {
    return { ok: false, reason: "invalid_price" };
  }
  if (!isIsoInstant(observationAt)) {
    return { ok: false, reason: "invalid_observation_at" };
  }
  if (
    !marketTimezone ||
    !INTERVALS.has(interval) ||
    !QUALITIES.has(quality) ||
    !ADJUSTMENT_STATES.has(adjustmentState)
  ) {
    return { ok: false, reason: "invalid_quote_metadata" };
  }
  let validatedDelayedMinutes: number | null = null;
  if (delayedMinutes !== null && delayedMinutes !== undefined) {
    if (
      typeof delayedMinutes !== "number" ||
      !Number.isInteger(delayedMinutes) ||
      delayedMinutes < 0
    ) {
      return { ok: false, reason: "invalid_quote_metadata" };
    }
    validatedDelayedMinutes = delayedMinutes;
  }
  // Review B2 fix: `sourceLabel` is free text with no dedicated malformed
  // reason (it never affected write correctness -- see the write path's own
  // comment), so an over-long value is TRUNCATED rather than rejected,
  // matching `app/price-upload-service.ts`'s `sanitizeSourceLabel` (same
  // `MAX_SOURCE_LABEL_LENGTH`) instead of failing the whole row closed for a
  // display-only field.
  const boundedSourceLabel = sourceLabel.slice(0, MAX_SOURCE_LABEL_LENGTH);
  return {
    ok: true,
    row: {
      physicalRowNumber,
      providerId,
      sourceLabel: boundedSourceLabel,
      providerSymbol,
      providerExchange,
      currencyCode,
      marketDate,
      priceDecimal,
      observationAt,
      marketTimezone,
      interval: interval as PriceBackupDataRow["interval"],
      quality: quality as PriceBackupDataRow["quality"],
      adjustmentState: adjustmentState as PriceBackupDataRow["adjustmentState"],
      delayedMinutes: validatedDelayedMinutes,
    },
  };
}

/**
 * Sanitizes the browser's OWN per-reason malformed-row breakdown (computed
 * client-side from rows the real parser above already dropped before ever
 * sending them) -- informational display only (the owner's "N malformed
 * rows: X wrong price, Y unknown provider" preview text), never trusted for
 * anything write-affecting. An unrecognised key or a non-integer/negative
 * count is dropped rather than coerced -- fail-closed, matching this
 * module's own untrusted-input discipline.
 */
export function sanitizeUploadedMalformedByReason(
  candidate: unknown,
): Partial<Record<PriceBackupMalformedReason, number>> {
  const result: Partial<Record<PriceBackupMalformedReason, number>> = {};
  if (typeof candidate !== "object" || candidate === null) return result;
  const record = candidate as Record<string, unknown>;
  for (const reason of PRICE_BACKUP_MALFORMED_REASONS) {
    const value = record[reason];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      result[reason] = value;
    }
  }
  return result;
}

export type ValidateUploadedPriceBackupPayloadResult =
  | {
      ok: true;
      rows: PriceBackupDataRow[];
      malformed: PriceBackupMalformedRow[];
    }
  | { ok: false; message: string };

/**
 * Validates a full browser-parsed backup-restore payload (`{ rows }`) --
 * `app/price-upload-service.ts`'s server-authority layer calls this INSTEAD
 * of `parsePriceBackupCsv` for IMP-010A's browser-parse path.
 */
export function validateUploadedPriceBackupPayload(
  payload: unknown,
  limits: PriceBackupLimits = DEFAULT_PRICE_BACKUP_LIMITS,
): ValidateUploadedPriceBackupPayloadResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, message: "The upload payload is invalid." };
  }
  const rawRows = (payload as Record<string, unknown>).rows;
  if (!Array.isArray(rawRows)) {
    return { ok: false, message: "The upload payload is invalid." };
  }
  if (rawRows.length > limits.maxRows) {
    return {
      ok: false,
      message: `The file exceeded the ${limits.maxRows.toLocaleString("en-US")}-row limit. Split the backup into multiple files (e.g. by provider or date range) and re-import each.`,
    };
  }
  // F3 (recorded, not blocking): this row-count check runs BEFORE the
  // per-row loop below, so a payload that is BOTH over the row-count budget
  // AND contains per-row grammar-invalid rows only ever reports the
  // over-budget reason -- intentional (skips fully validating a payload
  // already being rejected) but noted since it means a hostile payload's
  // per-row problems never surface once it is also oversized.
  const rows: PriceBackupDataRow[] = [];
  const malformed: PriceBackupMalformedRow[] = [];
  rawRows.forEach((candidate, index) => {
    const physicalRowNumber = index + 2;
    const result = validateUploadedPriceBackupRow(physicalRowNumber, candidate);
    if (result.ok) rows.push(result.row);
    else malformed.push({ physicalRowNumber, reason: result.reason });
  });
  return { ok: true, rows, malformed };
}
