// MKT-008: a NEW, deliberately simpler, standalone parser for the "Historical
// Data" section's per-security price-history CSVs (owner directive:
// Intelligent Investor exports).
//
// Header shape (owner-supplied example): `DateTime<TAB>FMG` or
// `DateTime,FMG` -- the SECOND header column's name IS the ticker (the
// column holds that security's price), every column after it is ignored
// (owner directive). Data rows: `1998-03-12 00:00:00<TAB>0.07852` (a
// date-only `1998-03-12` form is also accepted -- see `parseCsvDate`).
//
// Malformed rows are NEVER silently dropped: each is counted with a reason
// and returned to the caller for disclosure in the preview, per this task's
// binding ruling and the money-honesty rule (a bad price row must fail that
// ROW, never coerce to a fabricated value).
//
// Text decoding (UTF-8/UTF-16 detection) lives in the shared
// `./text-encoding.ts` module -- see that file's header comment for the
// owner-reported UTF-16 bug this guards against (Excel-style "Unicode
// Text" TSV exports) -- rather than a copy local to this parser, so
// `price-backup-csv.ts` gets the identical detection for free.
//
// Second owner-reported bug (2026-08-21, `docs/FMG.csv` -- the owner's real
// file, never staged/committed): this header comment previously claimed "no
// embedded delimiters or quotes ever appear" and did a PLAIN delimiter
// split -- WRONG. The owner's real Intelligent Investor export is
// RFC-4180-style: UTF-8+BOM, COMMA-delimited, with QUOTED fields --
// `"DateTime","FMG","divFlag",...` / `"1998-03-12 00:00:00",0.07852,,,,,`
// (dates quoted, prices and trailing empty cells bare). A plain
// `.split(",")` left the literal quote characters in `headerColumns[0]`
// (`"DateTime"` with quotes, never equal to the bare string `"DateTime"`),
// producing the exact same misleading MISSING_HEADER error the earlier
// UTF-16 fix addressed for a different root cause. `splitCsvFields` below
// is a MINIMAL, deliberately non-full-RFC4180 quote-aware splitter (strips
// surrounding quotes, unescapes doubled `""`, and -- critically -- makes
// the delimiter split itself quote-aware so a quoted comma/tab can never
// wrongly break a column) -- not a full CSV library, but enough for this
// format's real shape: no embedded newlines inside quoted fields are
// handled (this format's fields are dates/tickers/prices, none of which
// legitimately contain a newline; a hostile/malformed file with one simply
// gets split mid-field like before, producing a malformed row rather than
// silent corruption -- fail-closed, not a data-integrity risk).

import { decodeText, stripBom } from "./text-encoding.ts";

/**
 * Splits one line into fields, honoring RFC-4180-lite double-quoting: a
 * field beginning with `"` (ignoring any leading whitespace) runs until its
 * CLOSING `"` -- a doubled `""` inside is unescaped to a literal `"`, and
 * the delimiter itself is inert while inside quotes (so a quoted field may
 * contain the delimiter without breaking the column split). Every returned
 * field is trimmed, matching this parser's pre-existing whitespace
 * tolerance for bare (unquoted) fields.
 */
function splitCsvFields(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.trim().length === 0) {
      // An opening quote: only recognised at the START of a field (any
      // whitespace accumulated so far is discarded, matching the final
      // trim every field already gets) -- a quote appearing mid-field
      // (never produced by this format's real data) is treated as literal
      // content instead of re-entering quote mode.
      field = "";
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      fields.push(field.trim());
      field = "";
      continue;
    }
    field += char;
  }
  fields.push(field.trim());
  return fields;
}

/** True when `needle` (a single character) appears OUTSIDE any quoted
 * field on `line` -- used so delimiter detection never mistakes a
 * delimiter character that only ever appears INSIDE a quoted value. */
function hasUnquotedChar(line: string, needle: string): boolean {
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && char === needle) return true;
  }
  return false;
}

export type PriceCsvLimits = Readonly<{ maxBytes: number; maxRows: number }>;

// Generous headroom for a single-security full daily-close history: ~30
// years of ASX trading days is roughly 7,500 rows at well under 100 bytes
// each -- 20,000 rows / 2 MiB comfortably covers a security's entire
// history with headroom, while still bounding a single upload the same way
// the ledger CSV's own `DEFAULT_IMPORT_LIMITS` bounds its uploads (this
// task's caps precedent).
export const DEFAULT_PRICE_CSV_LIMITS: PriceCsvLimits = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxRows: 20_000,
});

export type PriceCsvDataRow = Readonly<{
  /** 1-indexed physical row number, header counted as row 1 (mirrors
   * `import_rows.physical_row_number`'s convention: data rows start at 2). */
  physicalRowNumber: number;
  /** `YYYY-MM-DD`, the exchange-local trading date -- never a UTC-shifted
   * date; see `domain/market-data/exchange-timezone.ts` for how this becomes
   * an `observation_at` instant. */
  marketDate: string;
  /** Validated positive decimal string, preserved EXACTLY as the file wrote
   * it (never reformatted/rounded) -- money-as-decimal-string discipline. */
  priceDecimal: string;
}>;

export type PriceCsvMalformedReason =
  "wrong_column_count" | "invalid_date" | "invalid_price";

export type PriceCsvMalformedRow = Readonly<{
  physicalRowNumber: number;
  reason: PriceCsvMalformedReason;
}>;

export type ParsePriceCsvResult =
  | {
      ok: true;
      /** The raw ticker text from the header's second column, untouched
       * (callers upper-case/trim for matching; this preserves what the file
       * actually said for display). */
      ticker: string;
      delimiter: "," | "\t";
      rows: PriceCsvDataRow[];
      malformed: PriceCsvMalformedRow[];
    }
  | {
      ok: false;
      code:
        | "EMPTY_FILE"
        | "DECODE_FAILED"
        | "MISSING_HEADER"
        | "TICKER_INVALID"
        | "BYTE_LIMIT_EXCEEDED"
        | "ROW_LIMIT_EXCEEDED";
      message: string;
    };

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;
const TICKER_PATTERN = /^[A-Za-z0-9]{1,10}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?: \d{2}:\d{2}:\d{2})?$/;

function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && /[1-9]/.test(value);
}

function isValidCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().startsWith(`${year}-${month}-${day}`)
  );
}

function detectDelimiter(headerLine: string): "," | "\t" {
  // Tab takes priority when both are present -- Intelligent Investor's own
  // tab-separated export is one real shape this parser reads; the owner's
  // OTHER real export (`docs/FMG.csv`) is comma-delimited with quoted
  // fields, so detection must be quote-aware (2026-08-21 fix): a tab
  // character that only ever appears INSIDE a quoted value (never
  // observed in real data, but a quoted field could in principle contain
  // one) must not wrongly select tab over the file's actual comma
  // delimiter.
  return hasUnquotedChar(headerLine, "\t") ? "\t" : ",";
}

export function parsePriceCsv(
  bytes: Uint8Array,
  limits: PriceCsvLimits = DEFAULT_PRICE_CSV_LIMITS,
): ParsePriceCsvResult {
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
    // Drop a single trailing blank line from a final newline -- not a real
    // row -- but keep every other line (even blank ones mid-file) so their
    // physical row numbers stay accurate for the malformed-row report.
    return !(index === all.length - 1 && line.trim().length === 0);
  });
  if (lines.length === 0 || lines[0]!.trim().length === 0) {
    return {
      ok: false,
      code: "MISSING_HEADER",
      message: "The file has no header row.",
    };
  }
  if (lines.length - 1 > limits.maxRows) {
    return {
      ok: false,
      code: "ROW_LIMIT_EXCEEDED",
      message: "The file exceeded the configured row limit.",
    };
  }

  const headerLine = lines[0]!;
  const delimiter = detectDelimiter(headerLine);
  const headerColumns = splitCsvFields(headerLine, delimiter);
  if (headerColumns.length < 2 || headerColumns[0] !== "DateTime") {
    return {
      ok: false,
      code: "MISSING_HEADER",
      message:
        'The header must start with "DateTime" followed by the ticker column.',
    };
  }
  const ticker = headerColumns[1]!;
  if (!TICKER_PATTERN.test(ticker)) {
    return {
      ok: false,
      code: "TICKER_INVALID",
      message: "The header's ticker column name is not a valid ticker.",
    };
  }

  const rows: PriceCsvDataRow[] = [];
  const malformed: PriceCsvMalformedRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const physicalRowNumber = index + 1;
    if (line.trim().length === 0) continue;
    const columns = splitCsvFields(line, delimiter);
    if (columns.length < 2) {
      malformed.push({ physicalRowNumber, reason: "wrong_column_count" });
      continue;
    }
    const [rawDate, rawPrice] = columns;
    if (!isValidCalendarDate(rawDate!)) {
      malformed.push({ physicalRowNumber, reason: "invalid_date" });
      continue;
    }
    if (!isPositiveDecimal(rawPrice!)) {
      malformed.push({ physicalRowNumber, reason: "invalid_price" });
      continue;
    }
    const marketDate = DATE_PATTERN.exec(rawDate!)!.slice(1, 4).join("-");
    rows.push({ physicalRowNumber, marketDate, priceDecimal: rawPrice! });
  }

  return { ok: true, ticker, delimiter, rows, malformed };
}
