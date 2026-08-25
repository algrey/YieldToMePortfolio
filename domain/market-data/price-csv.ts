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
// MKT-020 (2026-08-25, owner-directed): a SECOND format variant, AUTO-
// DETECTED by an EXACT column-name signature (quoting optional -- detection
// runs on the already quote-stripped header columns, so an unquoted header
// with the same eight names in the same order matches identically; never
// confused with the format above -- an unrecognised header still falls
// through to that format's own honest `MISSING_HEADER` error): the owner's
// other real export shape, an OHLCV-style daily CSV --
//   "Date","Open","High","Low","Close","Volume","Daily Movement","Daily Movement (Percent)"
//   "24 Aug 2026","$21.15","$21.68","$21.11","$21.44","2,420,147","0.29","1.37%"
// Owner ruling (close-only, deliberately NOT storing OHLCV): this
// deployment's free-plan constraint is ROW COUNT, not column count, so
// adding Open/High/Low/Volume/Movement columns would buy nothing -- only
// `Close` (this app's one price fact) is extracted; every other column is
// read from the file and then discarded. This is REVERSIBLE, not a data
// loss: the owner's original CSVs are retained outside this app (never
// deleted by an import), so if OHLCV storage is ever wanted later, the
// SAME files can be re-imported against a future schema/parser change --
// nothing about today's close-only choice destroys the source data.
// Ticker: this format carries NO ticker column (unlike the format above,
// whose second header name IS the ticker) -- the ticker is instead derived
// from the FILENAME, per the established `ASX-<TICKER>.csv` download
// convention (`app/price-history-coverage-format.ts`'s `iiDownloadFilename`
// names exactly this shape for the guided download flow). A misnamed file
// is caught the same way a misidentified ticker always is: the preview's
// matched-security confirmation names what it actually matched, so the
// owner can catch a wrong filename before confirming, same as any other
// mismatch.
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
import {
  isNoDataPriceCell,
  isPositiveDecimal,
  isValidMarketDate,
} from "./price-value-grammar.ts";

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

/**
 * EFF-001 (measure 4): `"no_data"` is a DISTINCT reason from
 * `"invalid_price"` -- a blank/zero price cell (`isNoDataPriceCell`) is an
 * honest absence of a trade for that day, not corrupt/garbage input.
 * Callers disclose it separately ("N no-data rows omitted") rather than
 * folding it into a generic "malformed" count that would wrongly suggest
 * the file itself is broken.
 */
export type PriceCsvMalformedReason =
  "wrong_column_count" | "invalid_date" | "invalid_price" | "no_data";

export type PriceCsvMalformedRow = Readonly<{
  physicalRowNumber: number;
  reason: PriceCsvMalformedReason;
}>;

export type ParsePriceCsvResult =
  | {
      ok: true;
      /** The raw ticker text -- from the header's second column for the
       * original `DateTime,<TICKER>` format, or from the FILENAME's
       * `ASX-<TICKER>.csv` segment for the MKT-020 OHLCV variant (that
       * format's header carries no ticker column) -- untouched either way
       * (callers upper-case/trim for matching; this preserves what the
       * file/filename actually said for display). */
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

const TICKER_PATTERN = /^[A-Za-z0-9]{1,10}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?: \d{2}:\d{2}:\d{2})?$/;

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

// ---------------------------------------------------------------------------
// MKT-020: the OHLCV close-only variant -- see this module's header comment
// for the owner ruling this section implements.
// ---------------------------------------------------------------------------

/** The variant's exact column-name signature, checked AFTER `splitCsvFields`
 * (which already strips any surrounding quotes and trims whitespace) --
 * quoting is therefore optional: an unquoted header with these same eight
 * names in this same order matches identically to the owner's quoted
 * sample. Detection is an EXACT array match, never a fuzzy/partial one, so a
 * header that merely resembles this shape (different casing, extra/missing/
 * reordered columns) honestly falls through to the format above's own
 * `MISSING_HEADER` error rather than being silently misread. */
const OHLCV_HEADER_SIGNATURE = [
  "Date",
  "Open",
  "High",
  "Low",
  "Close",
  "Volume",
  "Daily Movement",
  "Daily Movement (Percent)",
] as const;

const OHLCV_DATE_COLUMN_INDEX = 0;
const OHLCV_CLOSE_COLUMN_INDEX = 4;

function isOhlcvHeader(columns: readonly string[]): boolean {
  return (
    columns.length === OHLCV_HEADER_SIGNATURE.length &&
    OHLCV_HEADER_SIGNATURE.every((name, index) => columns[index] === name)
  );
}

/** Day-month-abbreviation-year date table ("24 Aug 2026" style). Exact,
 * Title-case abbreviations ONLY -- a different casing ("AUG"/"aug"/"aUg")
 * is a REJECTED, not silently normalized, form: this parser has exactly one
 * real sample to go on (the owner's verbatim export), and guessing at case
 * variants it has never actually seen would trade an honest error for a
 * fabricated acceptance rule. */
const OHLCV_MONTH_ABBREVIATIONS: Readonly<Record<string, string>> =
  Object.freeze({
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  });

const OHLCV_DATE_PATTERN = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/;

/** Parses "24 Aug 2026" into `YYYY-MM-DD`, or `null` for anything
 * unrecognised -- an unknown/mis-cased month abbreviation, a non-4-digit
 * year (a 2-digit year is REJECTED outright: it is genuinely ambiguous
 * which century it means, never guessed), or a day/month combination that
 * is not a real calendar date (day 32, 30 Feb, ...), reusing the SAME
 * `isValidCalendarDate` round-trip check the other format's date grammar
 * already enforces -- one definition of "a real calendar date", not two. */
function parseOhlcvDate(value: string): string | null {
  const match = OHLCV_DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, dayRaw, monthAbbrev, year] = match;
  const month = OHLCV_MONTH_ABBREVIATIONS[monthAbbrev!];
  if (!month) return null;
  const day = dayRaw!.padStart(2, "0");
  const candidate = `${year}-${month}-${day}`;
  return isValidCalendarDate(candidate) ? candidate : null;
}

/** Strips exactly one leading `$` (the owner's export prefixes every dollar
 * figure this way); a cell with no leading `$` is passed through unchanged
 * rather than rejected outright, since the grammar check right after this
 * still catches anything that isn't actually a valid price. The result is
 * NOT further massaged (no thousands-separator stripping): a close cell
 * carrying a `,` (e.g. a hypothetical `"$1,234.56"`) fails the shared
 * `isPositiveDecimal` grammar below and is honestly rejected as
 * `invalid_price` -- the owner's sample only ever shows thousands
 * separators in `Volume` (an ignored column), so accepting one in `Close`
 * would be inventing a form no real file has shown yet; see this module's
 * header comment. */
function stripLeadingDollarSign(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
}

/** The established `ASX-<TICKER>.csv` download-filename convention
 * (`app/price-history-coverage-format.ts`'s `iiDownloadFilename`) --
 * case-insensitive on the "ASX-" prefix and ".csv" suffix (a filesystem
 * concern, not a financial one -- some OSes/browsers alter filename case),
 * but the captured ticker text itself is returned EXACTLY as written in
 * the filename (never case-coerced), matching this module's existing
 * "preserve what the file actually said" convention for the header-derived
 * ticker in the other format. Tolerates exactly ONE trailing browser
 * duplicate-download suffix (` (1)`, ` (2)`, ...) immediately before the
 * extension -- the guided MKT-018B download flow routinely produces
 * `ASX-SHL (1).csv` when the owner re-downloads the same ticker's export,
 * and rejecting that real, common shape would defeat the whole guided
 * workflow over a cosmetic OS/browser artifact, not a real ambiguity (the
 * suffix is discarded, never folded into the returned ticker text). Only
 * ONE such suffix is tolerated -- a doubled one (`ASX-SHL (1) (2).csv`)
 * does not match, kept honestly tight rather than open-endedly permissive.
 * Returns `null` for anything else that does not match -- an honest error,
 * never a guessed ticker (e.g. a filename that never carried the `ASX-`
 * prefix at all, such as a browser's own `download (1).csv` default, is
 * NOT a "duplicate of an ASX ticker" and stays rejected). */
const OHLCV_FILENAME_TICKER_PATTERN =
  /^ASX-([A-Za-z0-9]{1,10})(?: \(\d+\))?\.csv$/i;

function deriveTickerFromOhlcvFilename(
  filename: string | undefined,
): string | null {
  if (typeof filename !== "string") return null;
  const match = OHLCV_FILENAME_TICKER_PATTERN.exec(filename.trim());
  return match ? match[1]! : null;
}

/** The OHLCV variant's own row loop -- structurally identical in shape to
 * the format above's loop (malformed rows counted by reason, never
 * dropped), differing only in: which columns are read (`Date`/`Close` by
 * fixed index, everything else ignored per the owner's close-only ruling),
 * the date grammar (`parseOhlcvDate` instead of the bare/timestamped
 * `YYYY-MM-DD` grammar), and the `$`-strip before the SAME shared price
 * grammar (`isNoDataPriceCell`/`isPositiveDecimal`) applies. */
function parseOhlcvVariant(
  lines: readonly string[],
  delimiter: "," | "\t",
  filename: string | undefined,
): ParsePriceCsvResult {
  const ticker = deriveTickerFromOhlcvFilename(filename);
  if (!ticker) {
    return {
      ok: false,
      code: "TICKER_INVALID",
      message:
        'Could not determine the ticker from the filename -- expected "ASX-<TICKER>.csv".',
    };
  }
  const rows: PriceCsvDataRow[] = [];
  const malformed: PriceCsvMalformedRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const physicalRowNumber = index + 1;
    if (line.trim().length === 0) continue;
    const columns = splitCsvFields(line, delimiter);
    if (columns.length !== OHLCV_HEADER_SIGNATURE.length) {
      malformed.push({ physicalRowNumber, reason: "wrong_column_count" });
      continue;
    }
    const marketDate = parseOhlcvDate(columns[OHLCV_DATE_COLUMN_INDEX]!);
    if (!marketDate) {
      malformed.push({ physicalRowNumber, reason: "invalid_date" });
      continue;
    }
    const closeCell = stripLeadingDollarSign(
      columns[OHLCV_CLOSE_COLUMN_INDEX]!,
    );
    if (isNoDataPriceCell(closeCell)) {
      malformed.push({ physicalRowNumber, reason: "no_data" });
      continue;
    }
    if (!isPositiveDecimal(closeCell)) {
      malformed.push({ physicalRowNumber, reason: "invalid_price" });
      continue;
    }
    rows.push({ physicalRowNumber, marketDate, priceDecimal: closeCell });
  }
  return { ok: true, ticker, delimiter, rows, malformed };
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
  /** MKT-020: the uploaded file's own name, used ONLY to derive the ticker
   * for the OHLCV close-only variant (that format's header carries no
   * ticker column -- see this module's header comment). Ignored entirely
   * for the original `DateTime,<TICKER>` format, whose ticker still comes
   * from the header as before -- so every pre-existing call site (which
   * never passed a third argument) keeps working unchanged. */
  filename?: string,
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
  // MKT-020: exact-signature detection runs FIRST, before the original
  // format's own header check -- an exact match hands off to the OHLCV
  // variant entirely; anything else (including a header that merely
  // resembles it) falls through to the original format's detection,
  // untouched, and its own honest `MISSING_HEADER` error for a truly
  // unrecognised header.
  if (isOhlcvHeader(headerColumns)) {
    return parseOhlcvVariant(lines, delimiter, filename);
  }
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
    if (isNoDataPriceCell(rawPrice!)) {
      malformed.push({ physicalRowNumber, reason: "no_data" });
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

// ---------------------------------------------------------------------------
// IMP-010A: browser-parse/server-authority split.
//
// The functions above run in the BROWSER now (imported directly into
// `historical-data-panel.tsx`'s "use client" bundle -- see that file and
// `app/price-upload-service.ts`'s header comment) so the CPU-heavy text
// decode/split/row-classify work never runs on the Worker. The functions
// below are the SERVER's side of that split: they re-validate the
// STRUCTURED rows a browser-parsed upload payload claims are valid, using
// the EXACT SAME grammar (`price-value-grammar.ts`'s `isPositiveDecimal`/
// `isValidMarketDate`, and this file's own `TICKER_PATTERN`) the parser
// above already enforces -- never a second, potentially-drifting
// definition of "valid". Per AGENTS.md, client output is untrusted input:
// a hostile payload that skips the browser parser entirely (a
// hand-crafted `fetch` call, not a real upload) must be rejected exactly
// as if the equivalent malformed text had reached the OLD server-side
// parser, row by row, fail-closed.
// ---------------------------------------------------------------------------

/** One row of an already browser-normalized upload payload -- the shape
 * `PriceCsvDataRow` reduces to once its `physicalRowNumber` (meaningless
 * for a payload the owner never sees broken down by source line -- see
 * this module's IMP-010A section header) is dropped. */
export type PriceCsvUploadedRowInput = Readonly<{
  marketDate: unknown;
  priceDecimal: unknown;
}>;

export type ValidateUploadedPriceCsvRowResult =
  | { ok: true; row: PriceCsvDataRow }
  | { ok: false; reason: PriceCsvMalformedReason };

/** Re-validates ONE row from an untrusted uploaded payload. `marketDate`
 * must already be the parser's NORMALIZED `YYYY-MM-DD` form (no time
 * suffix) -- a real browser upload always sends exactly that, since it ran
 * the same `parsePriceCsv` above; a hostile payload sending the raw
 * `YYYY-MM-DD HH:MM:SS` form is correctly rejected as `invalid_date`
 * rather than silently re-normalized, since untrusted input must be
 * validated in the shape the contract declares, not coerced. */
export function validateUploadedPriceCsvRow(
  physicalRowNumber: number,
  candidate: unknown,
): ValidateUploadedPriceCsvRowResult {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return { ok: false, reason: "wrong_column_count" };
  }
  const record = candidate as Record<string, unknown>;
  const { marketDate, priceDecimal } = record;
  if (typeof marketDate !== "string" || typeof priceDecimal !== "string") {
    return { ok: false, reason: "wrong_column_count" };
  }
  if (!isValidMarketDate(marketDate)) {
    return { ok: false, reason: "invalid_date" };
  }
  // EFF-001 (measure 4): a real browser upload already omits no-data rows
  // before sending (see this module's `PriceCsvMalformedReason` header
  // comment) -- an honest browser payload never carries one. A hostile
  // payload that sends one anyway is classified the SAME way the raw-text
  // parser above would, not silently accepted as a genuine price.
  if (isNoDataPriceCell(priceDecimal)) {
    return { ok: false, reason: "no_data" };
  }
  if (!isPositiveDecimal(priceDecimal)) {
    return { ok: false, reason: "invalid_price" };
  }
  return { ok: true, row: { physicalRowNumber, marketDate, priceDecimal } };
}

/** Re-validates the header-derived ticker an uploaded payload claims --
 * same `TICKER_PATTERN` the raw-text header parser above enforces. */
export function validateUploadedPriceCsvTicker(
  candidate: unknown,
): string | null {
  return typeof candidate === "string" && TICKER_PATTERN.test(candidate)
    ? candidate
    : null;
}

export type ValidateUploadedPriceCsvPayloadResult =
  | {
      ok: true;
      ticker: string;
      rows: PriceCsvDataRow[];
      malformed: PriceCsvMalformedRow[];
    }
  | { ok: false; message: string };

/**
 * Validates a full browser-parsed upload payload (`{ ticker, rows }`,
 * `unknown` because it arrived as untrusted JSON over the wire) --
 * `app/price-upload-service.ts`'s server-authority layer calls this INSTEAD
 * of `parsePriceCsv` for IMP-010A's browser-parse path. Row-count budget
 * mirrors `parsePriceCsv`'s own `limits.maxRows` check (the 20k-row cap
 * still applies, re-checked here since the server no longer sees the
 * original file's byte size to bound directly -- see this task's
 * CSV_IMPORT_SPEC.md note on the budget's post-IMP-010A shape).
 */
export function validateUploadedPriceCsvPayload(
  payload: unknown,
  limits: PriceCsvLimits = DEFAULT_PRICE_CSV_LIMITS,
): ValidateUploadedPriceCsvPayloadResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, message: "The upload payload is invalid." };
  }
  const record = payload as Record<string, unknown>;
  const ticker = validateUploadedPriceCsvTicker(record.ticker);
  if (!ticker) {
    return {
      ok: false,
      message: "The header's ticker column name is not a valid ticker.",
    };
  }
  const rawRows = record.rows;
  if (!Array.isArray(rawRows)) {
    return { ok: false, message: "The upload payload is invalid." };
  }
  if (rawRows.length > limits.maxRows) {
    return {
      ok: false,
      message: "The file exceeded the configured row limit.",
    };
  }
  const rows: PriceCsvDataRow[] = [];
  const malformed: PriceCsvMalformedRow[] = [];
  rawRows.forEach((candidate, index) => {
    // Payload rows carry no source line number (the browser already
    // dropped its malformed rows before sending) -- a synthetic 1-indexed
    // position (header counted as row 1, matching `parsePriceCsv`'s
    // convention) is good enough since no caller ever surfaces this number
    // to the owner for THIS payload shape (see this module's IMP-010A
    // section header).
    const physicalRowNumber = index + 2;
    const result = validateUploadedPriceCsvRow(physicalRowNumber, candidate);
    if (result.ok) rows.push(result.row);
    else malformed.push({ physicalRowNumber, reason: result.reason });
  });
  return { ok: true, ticker, rows, malformed };
}

// ---------------------------------------------------------------------------
// EFF-001 (measure 5): client-side pre-boundary downsampling.
//
// Owner ruling (2026-08-25, TASKS.md EFF-001): keeping every daily row of a
// multi-decade single-security history costs write quota disproportionate to
// its value once it is many years old, but the owner explicitly rejected a
// holding-window default (option 1) -- full history stays the default so a
// backup/export of this database stays "useful [and] shareable". The
// compromise: DOWNSAMPLE (never discard) pre-boundary history to one row per
// calendar month, ON by default, with the boundary year and the toggle both
// adjustable per import. This is purely a CLIENT-side row-selection choice
// over rows already known valid (`PriceCsvDataRow[]`) -- the server places no
// requirement on upload cadence and never re-derives or enforces this
// (a client that uploads full daily history anyway is not a correctness
// bug, only a missed budget optimization).
// ---------------------------------------------------------------------------

/** Owner-confirmed default boundary year (TASKS.md EFF-001 ruling, verbatim:
 * "monthly before 2018 an[d] configurable on import"). */
export const DEFAULT_DOWNSAMPLE_BOUNDARY_YEAR = 2018;

export type DownsamplePriceCsvOptions = Readonly<{
  /** Calendar year (inclusive) from which rows stay daily -- every row
   * dated `${boundaryYear}-01-01` or later passes through unchanged. */
  boundaryYear: number;
}>;

export type DownsamplePriceCsvResult = Readonly<{
  /** Post-downsample rows, sorted ascending by `marketDate`: every
   * on/after-boundary row unchanged, plus at most one row per calendar
   * month for before-boundary rows. */
  rows: PriceCsvDataRow[];
  /** How many rows this call actually dropped (`rows.length` before minus
   * after) -- the caller's honest "N rows instead of M" preview figure. */
  droppedCount: number;
}>;

/**
 * Keeps ONE row per calendar month -- the month's LAST trading observation,
 * chosen by comparing `marketDate` values (not array position, so caller
 * order need not be pre-sorted) -- for every row dated before
 * `${options.boundaryYear}-01-01`; every on/after-boundary row passes
 * through untouched, so recent history stays full daily resolution. Applied
 * ONLY to already-valid rows (never to a malformed/no-data row, which
 * `parsePriceCsv`/`validateUploadedPriceCsvPayload` already excluded from
 * `rows` before this ever runs). A no-op (returns `rows` as given,
 * `droppedCount: 0`) when every row is already on/after the boundary.
 */
export function downsamplePriceCsvRows(
  rows: readonly PriceCsvDataRow[],
  options: DownsamplePriceCsvOptions,
): DownsamplePriceCsvResult {
  const boundaryDate = `${String(options.boundaryYear).padStart(4, "0")}-01-01`;
  const monthlyWinners = new Map<string, PriceCsvDataRow>();
  const onOrAfterBoundary: PriceCsvDataRow[] = [];
  for (const row of rows) {
    if (row.marketDate >= boundaryDate) {
      onOrAfterBoundary.push(row);
      continue;
    }
    const monthKey = row.marketDate.slice(0, 7); // "YYYY-MM"
    const existing = monthlyWinners.get(monthKey);
    if (!existing || row.marketDate > existing.marketDate) {
      monthlyWinners.set(monthKey, row);
    }
  }
  const kept = [...monthlyWinners.values(), ...onOrAfterBoundary].sort(
    (left, right) =>
      left.marketDate < right.marketDate
        ? -1
        : left.marketDate > right.marketDate
          ? 1
          : 0,
  );
  return { rows: kept, droppedCount: rows.length - kept.length };
}

// ---------------------------------------------------------------------------
// EFF-001 (measure 2, review B1 fix 2026-08-25): delta-upload must compare
// VALUE, not just presence.
//
// The first version of this measure filtered by `marketDate` alone -- fatal:
// a CSV carrying a CORRECTED price for an already-imported date was silently
// never uploaded (the date "already existed", so the row was dropped before
// ever reaching the server), while `SinglePreviewSummary` kept telling the
// owner "Confirming will write these observations ... overwriting the price
// on any date already imported" -- a promise the code no longer kept. Fixed
// by comparing (marketDate, priceDecimal) together: a row is "already
// present" ONLY when BOTH match an existing observation EXACTLY (the SAME
// string, never a numeric-equivalence compare -- money-as-decimal-string
// discipline, matching `writePriceUploadObservations`'s measure-3 guard's
// own exact-string comparison, so the two layers never disagree about what
// counts as "identical"). A row whose date is covered but whose price
// differs is NEVER filtered -- it uploads, and the server's upsert (plus
// measure 3's identical-value guard) converges it normally, exactly like an
// ordinary correction always has.
// ---------------------------------------------------------------------------

export type PriceCsvExistingObservation = Readonly<{
  marketDate: string;
  closeDecimal: string;
}>;

export type FilterAlreadyPresentRow = Readonly<{
  marketDate: string;
  priceDecimal: string;
}>;

export type FilterAlreadyPresentResult<T extends FilterAlreadyPresentRow> =
  Readonly<{
    /** Rows to actually upload -- every row NOT an exact (date, price)
     * duplicate of an existing observation. Order-preserving. */
    rows: T[];
    /** Rows dropped because they exactly matched an existing observation --
     * the honest "N identical row(s) already present -- skipped" count. */
    identicalCount: number;
  }>;

/**
 * Filters `rows` (already-valid, already-downsampled upload candidates)
 * against `existing` (this security's own prior owner-import observations,
 * `loadOwnerImportPriceObservationsForSecurity`) -- see this section's
 * header comment for the exact-match rule. Generic over `T` so callers can
 * pass either the parser's own `PriceCsvDataRow[]` or the client's reduced
 * `{ marketDate, priceDecimal }[]` upload-payload shape without a
 * throwaway re-mapping.
 */
export function filterRowsAlreadyPresent<T extends FilterAlreadyPresentRow>(
  rows: readonly T[],
  existing: readonly PriceCsvExistingObservation[],
): FilterAlreadyPresentResult<T> {
  const existingByDate = new Map<string, string>();
  for (const observation of existing) {
    existingByDate.set(observation.marketDate, observation.closeDecimal);
  }
  const kept: T[] = [];
  let identicalCount = 0;
  for (const row of rows) {
    const existingPrice = existingByDate.get(row.marketDate);
    if (existingPrice !== undefined && existingPrice === row.priceDecimal) {
      identicalCount += 1;
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, identicalCount };
}
