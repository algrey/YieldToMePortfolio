// MKT-008: a NEW, deliberately simpler, standalone parser for the "Historical
// Data" section's per-security price-history CSVs (owner directive:
// Intelligent Investor exports). This is NOT the ledger CSV parser
// (`domain/imports/strict-versioned-parser.ts`) -- that format is a
// multi-column transaction feed with quoted-field/escaping support this
// format never needs (Intelligent Investor's export is two plain columns:
// a date and a decimal price, comma- or tab-separated, no embedded
// delimiters or quotes ever appear in either). A hand-rolled quote-aware
// state machine would be unused complexity here, so this module does a
// plain delimiter split instead -- documented, not an oversight.
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

function detectDelimiter(headerLine: string): "," | "\t" {
  // Tab takes priority when both are present -- Intelligent Investor's own
  // export is tab-separated; a comma inside a free-text column (there are
  // none in this format) could never legitimately coexist with tabs, so tab
  // presence is the more specific signal.
  return headerLine.includes("\t") ? "\t" : ",";
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
  const headerColumns = headerLine
    .split(delimiter)
    .map((column) => column.trim());
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
    const columns = line.split(delimiter).map((column) => column.trim());
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
