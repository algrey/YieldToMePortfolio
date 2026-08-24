export type ImportWorkersPlan = "free" | "paid";

export type ImportLimits = Readonly<{
  maxBytes: number;
  maxRows: number;
  maxFieldLength: number;
}>;

export type ImportUploadAssessment =
  | {
      ok: true;
      maxBytes: number;
      maxRows: number;
    }
  | {
      ok: false;
      status: 403 | 413;
      code: "CSV_IMPORT_DISABLED" | "CSV_IMPORT_TOO_LARGE";
      message: string;
      maxBytes: number;
      maxRows: number;
    };

export type ImportIssueSeverity = "error" | "warning" | "info";

export type ImportIssueCode =
  | "HEADER_MISMATCH"
  | "COLUMN_COUNT"
  | "ROW_UNCLASSIFIED"
  | "ROW_AMBIGUOUS"
  | "TRANSACTION_TYPE_UNKNOWN"
  | "DATE_INVALID"
  | "DATE_TIME_CONFLICT"
  | "QUANTITY_INVALID"
  | "PRICE_INVALID"
  | "FX_ZERO_TREATED_AS_UNKNOWN"
  | "FEE_INVALID"
  | "ACCOUNTING_UNSUPPORTED"
  | "DUPLICATE_EXACT"
  | "DISPLAY_SYMBOL_OVERRIDE"
  | "CASH_ENCODING_INVALID"
  | "DIVIDEND_PER_SHARE_INVALID"
  | "FRANKING_INVALID"
  | "FRANKING_ON_NON_DIVIDEND"
  | "CSV_IMPORT_DISABLED"
  | "CSV_IMPORT_TOO_LARGE"
  | "ROW_LIMIT_EXCEEDED"
  | "FIELD_LIMIT_EXCEEDED"
  | "CSV_DECODE_FAILED"
  // BRK-005: a future-dated Sharesight payout with no confirmed id (not yet
  // paid) was skipped rather than staged -- see
  // `domain/sharesight-sync/transform.ts`.
  | "SHARESIGHT_PAYOUT_UNCONFIRMED"
  // BRK-005C: two or more Sharesight payouts in one fetch share the SAME
  // identity key (same holding, same paid_on) -- staged for visibility but
  // blocked from readiness until the owner resolves it manually, never
  // auto-disambiguated -- see `domain/sharesight-sync/transform.ts`.
  | "SHARESIGHT_PAYOUT_KEY_COLLISION"
  // BRK-010 review round 3 correction: the gate is a best-effort SECURITY-
  // CURRENCY proxy, in strict priority order -- REAL, DB-resolved evidence
  // (an instrument this user has already linked to a security, in this
  // portfolio, from any source) FIRST, then same-fetch trade evidence when
  // present, and otherwise NO fallback at all (never the portfolio's own
  // base currency -- round 2's fallback-to-base guess was itself corrected
  // away in round 3, since "no same-fetch trade" turned out to be the
  // realistic steady state for a recurring payout, not a rare edge case,
  // and nothing inside a batch can ever clear a wrongly-fired instance of
  // this code) -- see `domain/sharesight-sync/transform.ts`'s
  // `payoutSecurityCurrencyProxy`. A Sharesight payout paid in a currency
  // other than that proxy target, with no USABLE `exchange_rate` to
  // convert it (covers missing, zero, malformed, and over-24dp-precision
  // raw rates -- round 3 SMALL-1/SMALL-2, judged by whether
  // `invertToPortfolioConversionRate` actually returns a value -- PLUS
  // negative raw rates, round 4 correction: a negative rate inverts to a
  // negative VALUE, not `null`, so it needs an explicit non-positive check
  // on top of that return value, not the bare `!== null` test alone),
  // stages for visibility but blocks readiness until resolved
  // (confirm the payout in Sharesight so it carries a valid rate, then
  // re-sync) or excluded (IMP-008) -- but ONLY when conversion is actually
  // achievable (the proxy target equals the portfolio's own base currency)
  // AND the proxy has real evidence at all (a `null` proxy target -- no
  // evidence anywhere yet -- never blocks either, since nothing here can
  // tell whether conversion would even be needed); otherwise (the proxy
  // target itself differs from the portfolio base) no rate could ever make
  // the conversion valid, so this code is never emitted for that shape at
  // all -- see `transform.ts`'s `payoutMissingFxRateIssue`.
  | "SHARESIGHT_PAYOUT_FX_RATE_MISSING"
  // BRK-010 review round 2 finding B2 (product ruling): franking credits
  // are an AU-tax construct; whether Sharesight denominates a FOREIGN
  // payout's franking fields in AUD or in the payout's own currency is an
  // UNVERIFIED ASSUMPTION this codebase will not resolve by inspecting real
  // tax amounts (AGENTS.md's secrets/tax-data discipline). A foreign-to-
  // its-security payout (best-effort proxy, see
  // `domain/sharesight-sync/transform.ts`'s `payoutSecurityCurrencyProxy`)
  // whose franking total is NONZERO stages with this WARNING (never an
  // error -- it never blocks readiness) naming the unverified-currency
  // reason; `domain/dividends/history.ts`'s derivation independently marks
  // that record's franking UNKNOWN (never converted, never trusted
  // as-stored) regardless of whether this warning is later resolved/
  // excluded. A zero/absent franking total on a foreign payout (the
  // overwhelmingly common case -- foreign-currency dividends are typically
  // unfranked) never triggers this at all.
  | "SHARESIGHT_PAYOUT_FRANKING_CURRENCY_UNVERIFIED";

export type ImportFieldName =
  | "id"
  | "symbol"
  | "name"
  | "displaySymbol"
  | "exchange"
  | "portfolio"
  | "currency"
  | "sharesOwned"
  | "costPerShare"
  | "commission"
  | "transactionDate"
  | "transactionTime"
  | "purchaseExchangeRate"
  | "type"
  | "accounting"
  | "accountingExecutionIds"
  | "notes"
  | "frankingPerShare";

export type ImportIssue = Readonly<{
  code: ImportIssueCode;
  severity: ImportIssueSeverity;
  message: string;
  rowNumber?: number;
  field?: ImportFieldName;
}>;

export type ImportRowKind =
  "blank" | "definition" | "transaction" | "unsupported";

export type ImportTransactionKind =
  "buy" | "sell" | "cash_deposit" | "cash_withdrawal" | "dividend";

export type ImportHeaderReport = Readonly<{
  parserVersion: string;
  observedHeaders: string[];
  normalizedHeaders: string[];
  missingHeaders: string[];
  unknownHeaders: string[];
  duplicateHeaders: string[];
  signature: string;
}>;

type MutableNormalizedImportRow = {
  id: string | null;
  symbol: string | null;
  name: string | null;
  displaySymbol: string | null;
  exchange: string | null;
  portfolio: string | null;
  currency: string | null;
  sharesOwned: string | null;
  costPerShare: string | null;
  commission: string | null;
  transactionDate: string | null;
  transactionTime: string | null;
  purchaseExchangeRate: string | null;
  type: ImportTransactionKind | null;
  accounting: "fifo" | null;
  accountingExecutionIds: string | null;
  notes: string | null;
  tradeAtUtc: string | null;
  localTradeDate: string | null;
  cashEvent: "cash_deposit" | "cash_withdrawal" | null;
  // IMP-006: dividend-receipt row support. Populated only from the
  // 18-column dividend-capable header variant; absent under the original
  // 17-column header, in which case it is always null (unknown, never a
  // silent zero -- the column simply cannot report franking).
  frankingPerShare: string | null;
  // BRK-005: totals-only dividend shape for a source (Sharesight payouts)
  // that reports a TOTAL cash amount and total franking credits with no
  // share count at all -- never fabricated from `sharesOwned`/`costPerShare`.
  // Always `null` for a CSV-parsed row (no CSV column ever populates these);
  // set only by `domain/sharesight-sync/transform.ts` on a `type: "dividend"`
  // row built from a Sharesight payout, in which case `sharesOwned`/
  // `costPerShare`/`frankingPerShare` above are themselves always `null` on
  // that same row (see `db/repositories/import-commit.ts`'s dividend branch,
  // which reads exactly this signal to choose the totals-mode insert path).
  // Optional (not just nullable) so every pre-BRK-005 fixture/caller that
  // never mentions these two fields keeps compiling unchanged; read as
  // `?? null` wherever consumed.
  totalCashDecimal?: string | null;
  totalFrankingDecimal?: string | null;
  // BRK-009A: OPTIONAL Sharesight instrument metadata, carried through so a
  // later resolution/review step (BRK-009B) can use it -- never consumed by
  // THIS type or any CSV path. Always `null` for a CSV-parsed row (no CSV
  // column ever populates these); set (present, possibly null when
  // Sharesight itself didn't carry the value) only by
  // `domain/sharesight-sync/transform.ts`. Optional (not just nullable) so
  // every pre-BRK-009A fixture/caller that never mentions these fields keeps
  // compiling unchanged, mirroring `totalCashDecimal`/`totalFrankingDecimal`
  // above -- read as `?? null` wherever consumed. Deliberately EXCLUDED from
  // `app/sharesight-sync-service.ts`'s `canonicalRowDigestFields` value list
  // and from every row's own `fingerprint` (both stay keyed on pre-existing
  // fields only), so carrying these does not change the batch digest or any
  // row's fingerprint for existing data -- see that module and
  // `domain/sharesight-sync/transform.ts` for the stability proof.
  sharesightInstrumentId?: string | null;
  instrumentName?: string | null;
  isin?: string | null;
  // BRK-010: OPTIONAL Sharesight payout `exchange_rate` (live-confirmed,
  // BRK-008 §8.2), ALREADY CORRECTED to this codebase's multiply-to-
  // portfolio-base convention by `domain/sharesight-sync/transform.ts`'s
  // `invertToPortfolioConversionRate` (see that function's doc comment and
  // `SharesightPayout.exchangeRateDecimal`'s live evidence in
  // `contracts.ts` for the review-round B1 direction proof) -- Sharesight's
  // OWN conversion rate for a dividend paid in a currency other than the
  // security's/portfolio's own, carried through so commit-time can
  // honestly record a foreign-currency payout's cash total WITH its rate
  // rather than silently treating it as 1:1 (see `db/schema.ts`'s
  // `dividendManualRecords` header note and `domain/dividends/history.ts`'s
  // conversion-at-read logic). Always `null` for a CSV-parsed row and for
  // every TRADE row (buy/sell FX already has its own established
  // `purchaseExchangeRate` mechanism -- this field is payout-only).
  // Optional, absent-tolerant. BRK-010 review finding B2: unlike
  // `sharesightInstrumentId`/`instrumentName`/`isin` above (pure matching
  // aids, deliberately digest-excluded), this field is VALUE-BEARING money
  // data and therefore IS included in `app/sharesight-sync-service.ts`'s
  // `canonicalRowDigestFields` -- a corrected/late rate from Sharesight
  // must re-stage as a genuinely new batch (BRK-005B's identical digest
  // philosophy for a trade correction), never silently reuse a stale one.
  // The row's own `fingerprint` (identity/dedupe key) is unaffected either
  // way -- payout identity never depended on this field.
  exchangeRateDecimal?: string | null;
};

export type NormalizedImportRow = Readonly<MutableNormalizedImportRow>;

export type ParsedImportRow = Readonly<{
  rowNumber: number;
  kind: ImportRowKind;
  rawFields: string[];
  normalized: NormalizedImportRow;
  issues: ImportIssue[];
  fingerprint: string;
}>;

export type ImportParseSummary = Readonly<{
  totalRows: number;
  blankRows: number;
  definitionRows: number;
  transactionRows: number;
  unsupportedRows: number;
  cashTransactionRows: number;
  dividendRows: number;
  duplicateRows: number;
}>;

export type ImportParseSuccess = Readonly<{
  ok: true;
  parserVersion: string;
  fileFingerprint: string;
  header: ImportHeaderReport;
  rows: ParsedImportRow[];
  issues: ImportIssue[];
  summary: ImportParseSummary;
}>;

export type ImportParseFailure = Readonly<{
  ok: false;
  parserVersion: string;
  fileFingerprint: string;
  code:
    | "HEADER_MISMATCH"
    | "CSV_IMPORT_TOO_LARGE"
    | "ROW_LIMIT_EXCEEDED"
    | "FIELD_LIMIT_EXCEEDED"
    | "CSV_DECODE_FAILED";
  message: string;
  header?: ImportHeaderReport;
  issues: ImportIssue[];
}>;

export type ImportParseResult = ImportParseSuccess | ImportParseFailure;

export const SUPPORTED_IMPORT_PARSER_VERSION = "strict-17-column-v1";

export const SUPPORTED_IMPORT_HEADER = [
  "Id",
  "Symbol",
  "Name",
  "Display Symbol",
  "Exchange",
  "Portfolio",
  "Currency",
  "Shares Owned",
  "Cost Per Share",
  "Commission",
  "Transaction Date",
  "Transaction Time",
  "Purchase Exchange Rate",
  "Type",
  "Accounting",
  "Accounting Execution Ids",
  "Notes",
] as const satisfies readonly string[];

// IMP-006: a second, backward-compatible header version that adds one
// trailing column so broker exports can carry a dividend receipt's franking
// credit per share. `Type` gains a `Dividend` enum value under either
// header version (see `parseTransactionType`); it is only ever populated
// when this 18-column header is the one that matched (see `HEADER_TO_FIELD_NAME`).
// The original 17-column contract in `SUPPORTED_IMPORT_HEADER` above is
// untouched so existing uploads keep parsing under
// `SUPPORTED_IMPORT_PARSER_VERSION` exactly as before.
export const SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS =
  "strict-18-column-dividends-v1";

export const SUPPORTED_IMPORT_HEADER_WITH_DIVIDENDS = [
  ...SUPPORTED_IMPORT_HEADER,
  "Franking Credit Per Share",
] as const satisfies readonly string[];

// Deliberately typed as `readonly string[]` (not a literal-tuple `as const`)
// so callers can check membership of a plain `string` (e.g. a
// `import_batches.parser_version` column value) with `.includes(...)`
// without a type error.
export const SUPPORTED_IMPORT_PARSER_VERSIONS: readonly string[] = [
  SUPPORTED_IMPORT_PARSER_VERSION,
  SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS,
];

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxRows: 100_000,
  maxFieldLength: 1024 * 1024,
};

const SUPPORTED_FIELD_SET = new Set<ImportFieldName>([
  "id",
  "symbol",
  "name",
  "displaySymbol",
  "exchange",
  "portfolio",
  "currency",
  "sharesOwned",
  "costPerShare",
  "commission",
  "transactionDate",
  "transactionTime",
  "purchaseExchangeRate",
  "type",
  "accounting",
  "accountingExecutionIds",
  "notes",
  "frankingPerShare",
]);

const HEADER_TO_FIELD_NAME: Record<string, ImportFieldName> = {
  Id: "id",
  Symbol: "symbol",
  Name: "name",
  "Display Symbol": "displaySymbol",
  Exchange: "exchange",
  Portfolio: "portfolio",
  Currency: "currency",
  "Shares Owned": "sharesOwned",
  "Cost Per Share": "costPerShare",
  Commission: "commission",
  "Transaction Date": "transactionDate",
  "Transaction Time": "transactionTime",
  "Purchase Exchange Rate": "purchaseExchangeRate",
  Type: "type",
  Accounting: "accounting",
  "Accounting Execution Ids": "accountingExecutionIds",
  Notes: "notes",
  "Franking Credit Per Share": "frankingPerShare",
};

type SupportedHeaderDefinition = {
  parserVersion: string;
  headers: readonly string[];
};

const SUPPORTED_HEADER_DEFINITIONS: readonly SupportedHeaderDefinition[] = [
  {
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    headers: SUPPORTED_IMPORT_HEADER,
  },
  {
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS,
    headers: SUPPORTED_IMPORT_HEADER_WITH_DIVIDENDS,
  },
];

type CsvRowsResult =
  | { ok: true; rows: string[][] }
  | {
      ok: false;
      code: "ROW_LIMIT_EXCEEDED" | "FIELD_LIMIT_EXCEEDED" | "CSV_DECODE_FAILED";
      message: string;
    };

type HeaderValidationResult =
  | {
      ok: true;
      header: ImportHeaderReport;
      headerIndex: Map<ImportFieldName, number>;
    }
  | {
      ok: false;
      header: ImportHeaderReport;
    };

type RowClassification =
  | {
      kind: "blank";
      issues: ImportIssue[];
      normalized: MutableNormalizedImportRow;
    }
  | {
      kind: "definition";
      issues: ImportIssue[];
      normalized: MutableNormalizedImportRow;
    }
  | {
      kind: "transaction";
      issues: ImportIssue[];
      normalized: MutableNormalizedImportRow;
    }
  | {
      kind: "unsupported";
      issues: ImportIssue[];
      normalized: MutableNormalizedImportRow;
    };

function normalizeHeaderCell(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeText(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDecimalText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) {
    return null;
  }

  const sign = match[1] === "-" ? "-" : "";
  const integerPart = match[2].replace(/^0+(?=\d)/, "") || "0";
  const fractionalPart = (match[3] ?? "").replace(/0+$/, "");
  if (integerPart === "0" && fractionalPart.length === 0) {
    return "0";
  }

  return fractionalPart.length > 0
    ? `${sign}${integerPart}.${fractionalPart}`
    : `${sign}${integerPart}`;
}

function normalizeIssueSeverity(code: ImportIssueCode): ImportIssueSeverity {
  switch (code) {
    case "FX_ZERO_TREATED_AS_UNKNOWN":
    case "FRANKING_ON_NON_DIVIDEND":
      return "warning";
    case "DUPLICATE_EXACT":
    case "DISPLAY_SYMBOL_OVERRIDE":
      return "info";
    default:
      return "error";
  }
}

function makeIssue(
  code: ImportIssueCode,
  message: string,
  rowNumber?: number,
  field?: ImportFieldName,
): ImportIssue {
  return {
    code,
    severity: normalizeIssueSeverity(code),
    message,
    ...(rowNumber !== undefined ? { rowNumber } : {}),
    ...(field !== undefined ? { field } : {}),
  };
}

function parseTransactionType(value: string): ImportTransactionKind | null {
  switch (normalizeText(value)?.toLowerCase() ?? "") {
    case "buy":
      return "buy";
    case "sell":
      return "sell";
    case "dividend":
      return "dividend";
    default:
      return null;
  }
}

function parseAccountingMethod(value: string): "fifo" | null {
  const normalized = normalizeText(value)?.toLowerCase() ?? "";
  return normalized === "fifo" ? "fifo" : null;
}

function parseTimeOfDay(
  value: string,
): { hours: number; minutes: number; seconds: number } | null {
  const trimmed = normalizeText(value);
  if (trimmed === null) {
    return { hours: 0, minutes: 0, seconds: 0 };
  }

  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (match === null) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    Number.isNaN(seconds) ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null;
  }

  return { hours, minutes, seconds };
}

function parseOffsetMinutes(value: string): number | null {
  const match = /^GMT([+-])(\d{2})(\d{2})$/.exec(normalizeText(value) ?? "");
  if (match === null) {
    return null;
  }

  const magnitude = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -magnitude : magnitude;
}

function parseTradeTimestamp(
  transactionDate: string,
  transactionTime: string,
):
  | { ok: true; tradeAtUtc: string; localTradeDate: string }
  | { ok: false; code: "DATE_INVALID"; message: string } {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(GMT[+-]\d{4}))?$/.exec(
    normalizeText(transactionDate) ?? "",
  );
  if (dateMatch === null) {
    return {
      ok: false,
      code: "DATE_INVALID",
      message: "Transaction Date must use an explicit supported date format.",
    };
  }

  const time = parseTimeOfDay(transactionTime);
  if (time === null) {
    return {
      ok: false,
      code: "DATE_INVALID",
      message: "Transaction Time must use HH:MM:SS when provided.",
    };
  }

  const offset = parseOffsetMinutes(dateMatch[4] ?? "GMT+0000");
  if (offset === null) {
    return {
      ok: false,
      code: "DATE_INVALID",
      message: "Transaction Date must include an explicit GMT offset.",
    };
  }

  const utcMs =
    Date.UTC(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
      time.hours,
      time.minutes,
      time.seconds,
    ) -
    offset * 60_000;

  return {
    ok: true,
    tradeAtUtc: new Date(utcMs).toISOString(),
    localTradeDate: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
  };
}

// IMP-010B review round (fold 5): every size/count/malformed-content
// rejection this module can return -- both from the character-level
// `parseCsvText` loop below AND from `classifyImportRows`'s defense-in-depth
// re-checks over an untrusted `rows[][]` payload -- names the ACTUAL
// configured limit and suggests a concrete action, matching the
// `IMP-010A` round-2 precedent (`domain/market-data/price-backup-csv.ts`'s
// `formatMiB`-based messages). Both code paths call these SAME builders so
// the wording never drifts between "the browser rejected this before
// upload" and "the server rejected this after upload" for the identical
// failure code.
function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

function csvTooLargeMessage(limits: ImportLimits): string {
  return `The CSV exceeded the ${formatMiB(limits.maxBytes)} size limit. Split the file into smaller batches and import each separately.`;
}

function rowLimitExceededMessage(limits: ImportLimits): string {
  return `The CSV exceeded the ${limits.maxRows.toLocaleString("en-US")}-row limit. Split the file into smaller batches and import each separately.`;
}

function fieldLimitExceededMessage(limits: ImportLimits): string {
  return `A CSV field exceeded the ${limits.maxFieldLength.toLocaleString("en-US")}-character limit. Check the file for a corrupted or unterminated quoted value.`;
}

const NOT_VALID_UTF8_MESSAGE =
  "The supplied CSV is not valid UTF-8. Re-export or save the file as UTF-8 and try again.";
const NUL_OR_BINARY_MESSAGE =
  "The supplied CSV contains NUL or binary content. Remove the binary content and try again.";
const UNTERMINATED_QUOTE_MESSAGE =
  "The CSV contains an unterminated quoted field. Check the file for a missing closing quote.";

function parseCsvText(text: string, limits: ImportLimits): CsvRowsResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const appendField = (): CsvRowsResult | null => {
    if (field.length > limits.maxFieldLength) {
      return {
        ok: false,
        code: "FIELD_LIMIT_EXCEEDED",
        message: fieldLimitExceededMessage(limits),
      };
    }

    row.push(field);
    field = "";
    return null;
  };

  const appendRow = (): CsvRowsResult | null => {
    rows.push(row);
    row = [];
    if (rows.length > limits.maxRows + 1) {
      return {
        ok: false,
        code: "ROW_LIMIT_EXCEEDED",
        message: rowLimitExceededMessage(limits),
      };
    }

    return null;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else if (char === "\r") {
        if (text[index + 1] === "\n") {
          field += "\n";
          index += 1;
        } else {
          field += "\n";
        }
      } else if (char === "\n") {
        field += "\n";
      } else {
        field += char;
      }

      if (field.length > limits.maxFieldLength) {
        return {
          ok: false,
          code: "FIELD_LIMIT_EXCEEDED",
          message: fieldLimitExceededMessage(limits),
        };
      }
      continue;
    }

    if (char === '"') {
      if (field.length === 0) {
        inQuotes = true;
      } else {
        field += char;
      }
      continue;
    }

    if (char === ",") {
      const result = appendField();
      if (result !== null) {
        return result;
      }
      continue;
    }

    if (char === "\r" || char === "\n") {
      const fieldResult = appendField();
      if (fieldResult !== null) {
        return fieldResult;
      }

      const rowResult = appendRow();
      if (rowResult !== null) {
        return rowResult;
      }

      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    field += char;
    if (field.length > limits.maxFieldLength) {
      return {
        ok: false,
        code: "FIELD_LIMIT_EXCEEDED",
        message: fieldLimitExceededMessage(limits),
      };
    }
  }

  if (inQuotes) {
    return {
      ok: false,
      code: "CSV_DECODE_FAILED",
      message: UNTERMINATED_QUOTE_MESSAGE,
    };
  }

  if (field.length > 0 || row.length > 0) {
    const fieldResult = appendField();
    if (fieldResult !== null) {
      return fieldResult;
    }

    const rowResult = appendRow();
    if (rowResult !== null) {
      return rowResult;
    }
  }

  return { ok: true, rows };
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

// IMP-010B: written via `String.fromCharCode` rather than a `\u0000`
// escape literal so every NUL/binary-content check below is expressed the
// same way.
const NUL_CHARACTER = String.fromCharCode(0);

function toBytes(source: string | Uint8Array): Uint8Array {
  return typeof source === "string" ? new TextEncoder().encode(source) : source;
}

function decodeUtf8(source: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return null;
  }
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validateHeaderAgainst(
  rawHeader: string[],
  definition: SupportedHeaderDefinition,
): HeaderValidationResult {
  const supportedHeaderSet = new Set<string>(definition.headers);
  const normalizedHeaders = rawHeader.map((header) =>
    normalizeHeaderCell(header),
  );
  const observedHeaders = rawHeader.map((header) => header);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknownHeaders: string[] = [];

  for (const header of normalizedHeaders) {
    if (seen.has(header)) {
      if (supportedHeaderSet.has(header)) {
        duplicates.add(header);
      }
    } else {
      seen.add(header);
    }

    if (!supportedHeaderSet.has(header)) {
      unknownHeaders.push(header);
    }
  }

  const missingHeaders = definition.headers.filter(
    (header) => !seen.has(header),
  );

  const header: ImportHeaderReport = {
    parserVersion: definition.parserVersion,
    observedHeaders,
    normalizedHeaders,
    missingHeaders,
    unknownHeaders,
    duplicateHeaders: [...duplicates],
    signature: normalizedHeaders.join("\u001f"),
  };

  if (
    normalizedHeaders.length !== definition.headers.length ||
    missingHeaders.length > 0 ||
    unknownHeaders.length > 0 ||
    duplicates.size > 0
  ) {
    return { ok: false, header };
  }

  const headerIndex = new Map<ImportFieldName, number>();
  normalizedHeaders.forEach((header, index) => {
    const fieldName = HEADER_TO_FIELD_NAME[header];
    if (fieldName !== undefined) {
      headerIndex.set(fieldName, index);
    }
  });

  return { ok: true, header, headerIndex };
}

// Tries every supported header version, in order, and returns the first
// exact match. On total failure, the reported diff (missing/unknown
// headers) is always relative to the original 17-column contract -- the
// primary supported shape -- for a stable, familiar error message.
function validateHeader(rawHeader: string[]): HeaderValidationResult {
  for (const definition of SUPPORTED_HEADER_DEFINITIONS) {
    const result = validateHeaderAgainst(rawHeader, definition);
    if (result.ok) {
      return result;
    }
  }

  return validateHeaderAgainst(rawHeader, SUPPORTED_HEADER_DEFINITIONS[0]!);
}

function getField(
  row: string[],
  headerIndex: Map<ImportFieldName, number>,
  field: ImportFieldName,
): string {
  const index = headerIndex.get(field);
  return index === undefined ? "" : (row[index] ?? "");
}

function createNormalizedRow(
  row: string[],
  headerIndex: Map<ImportFieldName, number>,
): MutableNormalizedImportRow {
  const purchaseExchangeRateRaw = normalizeText(
    getField(row, headerIndex, "purchaseExchangeRate"),
  );
  const purchaseExchangeRateNormalized =
    purchaseExchangeRateRaw === null
      ? null
      : normalizeDecimalText(purchaseExchangeRateRaw);

  return {
    id: normalizeText(getField(row, headerIndex, "id")),
    symbol: normalizeText(getField(row, headerIndex, "symbol")),
    name: normalizeText(getField(row, headerIndex, "name")),
    displaySymbol: normalizeText(getField(row, headerIndex, "displaySymbol")),
    exchange: normalizeText(getField(row, headerIndex, "exchange")),
    portfolio: normalizeText(getField(row, headerIndex, "portfolio")),
    currency: normalizeText(getField(row, headerIndex, "currency")),
    sharesOwned: normalizeText(getField(row, headerIndex, "sharesOwned")),
    costPerShare: normalizeText(getField(row, headerIndex, "costPerShare")),
    commission: normalizeText(getField(row, headerIndex, "commission")),
    transactionDate: normalizeText(
      getField(row, headerIndex, "transactionDate"),
    ),
    transactionTime: normalizeText(
      getField(row, headerIndex, "transactionTime"),
    ),
    purchaseExchangeRate:
      purchaseExchangeRateNormalized === "0"
        ? null
        : purchaseExchangeRateNormalized,
    type: parseTransactionType(getField(row, headerIndex, "type")),
    accounting: parseAccountingMethod(getField(row, headerIndex, "accounting")),
    accountingExecutionIds: normalizeText(
      getField(row, headerIndex, "accountingExecutionIds"),
    ),
    notes: normalizeText(getField(row, headerIndex, "notes")),
    tradeAtUtc: null,
    localTradeDate: null,
    cashEvent: null,
    // Blank -> null (unknown, never a silent zero); "0" is a legitimate
    // explicit "unfranked" value and is preserved as-is -- unlike
    // `purchaseExchangeRate`, franking has no zero-means-missing rule.
    frankingPerShare: normalizeDecimalText(
      normalizeText(getField(row, headerIndex, "frankingPerShare")) ?? "",
    ),
    // BRK-005: never populated by CSV parsing -- see the type's header note.
    totalCashDecimal: null,
    totalFrankingDecimal: null,
  };
}

function isBlankRow(row: string[]): boolean {
  return row.every((field) => normalizeText(field) === null);
}

function isCashSymbol(symbol: string): boolean {
  return /^[A-Z]{3}=CASH$/.test(normalizeText(symbol) ?? "");
}

function normalizeRowForFingerprint(row: NormalizedImportRow): string {
  return [
    row.portfolio ?? "",
    row.type ?? "",
    row.cashEvent ?? "",
    row.symbol ?? "",
    row.exchange ?? "",
    row.currency ?? "",
    row.tradeAtUtc ?? "",
    row.sharesOwned ?? "",
    row.costPerShare ?? "",
    row.commission ?? "",
    row.id ?? "",
    row.accounting ?? "",
    row.accountingExecutionIds ?? "",
    row.notes ?? "",
    // Only a dividend row can carry franking (see classifyRow's
    // FRANKING_ON_NON_DIVIDEND guard), and only when it's actually present.
    // Appending unconditionally would change EVERY row's fingerprint --
    // including every legacy 17-column row, which can never have a
    // franking value at all -- breaking cross-version idempotency: the
    // exact same bytes committed under the 17-column parser would no
    // longer fingerprint-match themselves under a later re-import, and
    // would double-post. Appending only when non-null keeps a legacy
    // fingerprint byte-identical, and makes an 18-column row with blank
    // franking hash exactly like its 17-column equivalent.
    ...(row.type === "dividend" && row.frankingPerShare !== null
      ? [row.frankingPerShare]
      : []),
  ].join("|");
}

function classifyRow(
  row: string[],
  headerIndex: Map<ImportFieldName, number>,
  rowNumber: number,
  expectedColumnCount: number,
): RowClassification {
  const normalized = createNormalizedRow(row, headerIndex);
  const issues: ImportIssue[] = [];

  if (isBlankRow(row)) {
    return { kind: "blank", issues, normalized };
  }

  if (row.length !== expectedColumnCount) {
    issues.push(
      makeIssue(
        "COLUMN_COUNT",
        `The row does not contain the supported ${expectedColumnCount}-column shape.`,
        rowNumber,
      ),
    );
  }

  const hasIdentity =
    normalized.id !== null &&
    normalized.symbol !== null &&
    normalized.portfolio !== null &&
    normalized.currency !== null;

  const definitionShape =
    hasIdentity &&
    normalized.type === null &&
    normalized.transactionDate === null &&
    normalized.sharesOwned === null &&
    normalized.costPerShare === null &&
    normalized.commission === null;

  const transactionShape =
    hasIdentity &&
    normalized.type !== null &&
    normalized.transactionDate !== null &&
    normalized.sharesOwned !== null &&
    normalized.costPerShare !== null;

  if (definitionShape) {
    if (
      normalized.displaySymbol !== null &&
      normalized.displaySymbol !== normalized.symbol
    ) {
      issues.push(
        makeIssue(
          "DISPLAY_SYMBOL_OVERRIDE",
          "The row carries a display-symbol override.",
          rowNumber,
          "displaySymbol",
        ),
      );
    }

    return { kind: "definition", issues, normalized };
  }

  if (!transactionShape) {
    issues.push(
      makeIssue(
        "ROW_UNCLASSIFIED",
        "The row matches no supported import grammar.",
        rowNumber,
      ),
    );
    return { kind: "unsupported", issues, normalized };
  }

  if (normalized.type === null) {
    issues.push(
      makeIssue(
        "TRANSACTION_TYPE_UNKNOWN",
        "The transaction Type value is not supported.",
        rowNumber,
        "type",
      ),
    );
    return { kind: "unsupported", issues, normalized };
  }

  if (
    normalized.sharesOwned === null ||
    normalizeDecimalText(normalized.sharesOwned) === null ||
    normalizeDecimalText(normalized.sharesOwned) === "0"
  ) {
    issues.push(
      makeIssue(
        "QUANTITY_INVALID",
        "Shares Owned must be a positive decimal value.",
        rowNumber,
        "sharesOwned",
      ),
    );
  } else {
    normalized.sharesOwned = normalizeDecimalText(normalized.sharesOwned);
  }

  if (
    normalized.costPerShare === null ||
    normalizeDecimalText(normalized.costPerShare) === null ||
    normalizeDecimalText(normalized.costPerShare)?.startsWith("-") === true
  ) {
    issues.push(
      makeIssue(
        "PRICE_INVALID",
        "Cost Per Share must be a non-negative decimal value.",
        rowNumber,
        "costPerShare",
      ),
    );
  } else {
    normalized.costPerShare = normalizeDecimalText(normalized.costPerShare);
  }

  if (normalized.commission === null) {
    normalized.commission = "0";
  } else if (
    normalizeDecimalText(normalized.commission) === null ||
    normalizeDecimalText(normalized.commission)?.startsWith("-") === true
  ) {
    issues.push(
      makeIssue(
        "FEE_INVALID",
        "Commission must be a non-negative decimal value.",
        rowNumber,
        "commission",
      ),
    );
  } else {
    normalized.commission = normalizeDecimalText(normalized.commission);
  }

  if (normalized.type === "dividend" && normalized.costPerShare === "0") {
    issues.push(
      makeIssue(
        "DIVIDEND_PER_SHARE_INVALID",
        "Cost Per Share (dividend per share) must be a positive decimal value for a Dividend row.",
        rowNumber,
        "costPerShare",
      ),
    );
  }

  const rawFrankingPerShare = normalizeText(
    getField(row, headerIndex, "frankingPerShare"),
  );
  if (rawFrankingPerShare !== null && normalized.frankingPerShare === null) {
    // Present but did not normalize to a decimal at all (e.g. "abc") --
    // distinct from a blank column, which stays null/unknown with no issue.
    issues.push(
      makeIssue(
        "FRANKING_INVALID",
        "Franking Credit Per Share must be a valid decimal value.",
        rowNumber,
        "frankingPerShare",
      ),
    );
  } else if (
    normalized.frankingPerShare !== null &&
    normalized.frankingPerShare.startsWith("-")
  ) {
    issues.push(
      makeIssue(
        "FRANKING_INVALID",
        "Franking Credit Per Share must be a non-negative decimal value.",
        rowNumber,
        "frankingPerShare",
      ),
    );
  }

  if (normalized.type !== "dividend" && normalized.frankingPerShare !== null) {
    // Only a Dividend row's franking is meaningful/consumed; a stray value
    // on any other row type is surfaced (not silently dropped) but doesn't
    // block commit, and never contributes to the row's fingerprint (see
    // `normalizeRowForFingerprint`) -- only a Dividend row's franking is
    // part of that row's identity.
    issues.push(
      makeIssue(
        "FRANKING_ON_NON_DIVIDEND",
        "Franking Credit Per Share is only used on a Dividend row and is ignored here.",
        rowNumber,
        "frankingPerShare",
      ),
    );
  }

  const tradeTimestamp = parseTradeTimestamp(
    normalized.transactionDate ?? "",
    normalized.transactionTime ?? "",
  );
  if (!tradeTimestamp.ok) {
    issues.push(
      makeIssue(
        tradeTimestamp.code,
        tradeTimestamp.message,
        rowNumber,
        "transactionDate",
      ),
    );
  } else {
    normalized.tradeAtUtc = tradeTimestamp.tradeAtUtc;
    normalized.localTradeDate = tradeTimestamp.localTradeDate;
  }

  if (normalized.purchaseExchangeRate === null) {
    const rawPurchaseRate = normalizeText(
      getField(row, headerIndex, "purchaseExchangeRate"),
    );
    if (
      rawPurchaseRate !== null &&
      normalizeDecimalText(rawPurchaseRate) === "0"
    ) {
      issues.push(
        makeIssue(
          "FX_ZERO_TREATED_AS_UNKNOWN",
          "Purchase Exchange Rate zero is treated as unknown.",
          rowNumber,
          "purchaseExchangeRate",
        ),
      );
    }
  }

  if (normalized.accounting !== null && normalized.accounting !== "fifo") {
    issues.push(
      makeIssue(
        "ACCOUNTING_UNSUPPORTED",
        "Only FIFO accounting is supported by the supplied export.",
        rowNumber,
        "accounting",
      ),
    );
  }

  if (
    normalized.displaySymbol !== null &&
    normalized.displaySymbol !== normalized.symbol
  ) {
    issues.push(
      makeIssue(
        "DISPLAY_SYMBOL_OVERRIDE",
        "The row carries a display-symbol override.",
        rowNumber,
        "displaySymbol",
      ),
    );
  }

  if (normalized.symbol !== null && isCashSymbol(normalized.symbol)) {
    const cashCurrency = normalized.symbol.slice(0, 3);
    const exactCashShape =
      normalized.currency === cashCurrency &&
      normalized.exchange === null &&
      normalized.name === null &&
      normalized.displaySymbol === null &&
      normalized.costPerShare === "1" &&
      (normalized.commission === null || normalized.commission === "0");

    if (exactCashShape) {
      normalized.cashEvent =
        normalized.type === "buy" ? "cash_deposit" : "cash_withdrawal";
      return { kind: "transaction", issues, normalized };
    }

    issues.push(
      makeIssue(
        "CASH_ENCODING_INVALID",
        "Legacy cash rows must match the exact supported encoding.",
        rowNumber,
        "symbol",
      ),
    );
    return { kind: "unsupported", issues, normalized };
  }

  if (issues.some((issue) => issue.severity === "error")) {
    return { kind: "unsupported", issues, normalized };
  }

  normalized.cashEvent = null;
  return { kind: "transaction", issues, normalized };
}

function createHeaderMismatchFailure(
  fileFingerprint: string,
  header: ImportHeaderReport,
  message: string,
): ImportParseFailure {
  return {
    ok: false,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    fileFingerprint,
    code: "HEADER_MISMATCH",
    message,
    header,
    issues: [makeIssue("HEADER_MISMATCH", message)],
  };
}

function createUploadTooLargeFailure(
  fileFingerprint: string,
  message: string,
): ImportParseFailure {
  return {
    ok: false,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    fileFingerprint,
    code: "CSV_IMPORT_TOO_LARGE",
    message,
    issues: [makeIssue("CSV_IMPORT_TOO_LARGE", message)],
  };
}

export function assessCsvImportUploadStart(input: {
  workersPlan: ImportWorkersPlan;
  contentLength: number | null;
  maxBytes?: number;
  maxRows?: number;
}): ImportUploadAssessment {
  const maxBytes = input.maxBytes ?? DEFAULT_IMPORT_LIMITS.maxBytes;
  const maxRows = input.maxRows ?? DEFAULT_IMPORT_LIMITS.maxRows;

  if (input.workersPlan === "free") {
    return {
      ok: false,
      status: 403,
      code: "CSV_IMPORT_DISABLED",
      message: "Workers Free rejects CSV import before reading the body.",
      maxBytes,
      maxRows,
    };
  }

  if (input.contentLength !== null && input.contentLength > maxBytes) {
    return {
      ok: false,
      status: 413,
      code: "CSV_IMPORT_TOO_LARGE",
      message: "The CSV upload exceeds the configured size limit.",
      maxBytes,
      maxRows,
    };
  }

  return {
    ok: true,
    maxBytes,
    maxRows,
  };
}

export type ImportRowSplitFailureCode =
  | "CSV_IMPORT_TOO_LARGE"
  | "ROW_LIMIT_EXCEEDED"
  | "FIELD_LIMIT_EXCEEDED"
  | "CSV_DECODE_FAILED";

export type ImportRowSplitResult =
  | Readonly<{ ok: true; fileFingerprint: string; rows: string[][] }>
  | Readonly<{
      ok: false;
      fileFingerprint: string;
      code: ImportRowSplitFailureCode;
      message: string;
    }>;

// IMP-010B: this is the CPU-heavy half of the strict 17-column parser --
// byte decode, BOM strip, and RFC-4180-style quoted-field/row splitting.
// This half is what was too heavy to run on the Cloudflare Workers free
// plan (see `assessCsvImportUploadStart`'s now-superseded header note and
// CSV_IMPORT_SPEC.md's IMP-010B section); it now runs in the BROWSER
// (`app/components/import-review.tsx` imports THIS function directly from
// here, the SAME module the server used to run this over raw bytes),
// producing `rows: string[][]` -- still fully UNCLASSIFIED, no
// grammar/enum/decimal validation has happened AT ALL yet -- that the
// browser uploads to the server instead of the raw file.
//
// IMP-010B review round (B1 fix): this function's OWN job stops at
// splitting. `classifyImportRows` below (header validation, per-row
// grammar/enum/decimal rules, duplicate fingerprinting) is NEVER called
// from the browser bundle -- it runs ONLY on the server, over the rows
// this function (or a hostile payload skipping it entirely) produced. See
// `classifyImportRows`'s own header comment for why that single-authority
// shape is a STRONGER guarantee than a browser/server dual-run would be.
export async function splitStrictVersionedCsvRows(
  source: string | Uint8Array,
  limits: ImportLimits,
): Promise<ImportRowSplitResult> {
  const bytes = toBytes(source);
  const fileFingerprint = await sha256Hex(bytes);

  if (bytes.byteLength > limits.maxBytes) {
    return {
      ok: false,
      fileFingerprint,
      code: "CSV_IMPORT_TOO_LARGE",
      message: csvTooLargeMessage(limits),
    };
  }

  const decoded = decodeUtf8(bytes);
  if (decoded === null) {
    return {
      ok: false,
      fileFingerprint,
      code: "CSV_DECODE_FAILED",
      message: NOT_VALID_UTF8_MESSAGE,
    };
  }

  if (decoded.includes(NUL_CHARACTER)) {
    return {
      ok: false,
      fileFingerprint,
      code: "CSV_DECODE_FAILED",
      message: NUL_OR_BINARY_MESSAGE,
    };
  }

  const rowsResult = parseCsvText(stripBom(decoded), limits);
  if (!rowsResult.ok) {
    return {
      ok: false,
      fileFingerprint,
      code: rowsResult.code,
      message: rowsResult.message,
    };
  }

  return { ok: true, fileFingerprint, rows: rowsResult.rows };
}

function createRowSplitFailure(
  fileFingerprint: string,
  code: ImportRowSplitFailureCode,
  message: string,
): ImportParseFailure {
  return {
    ok: false,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    fileFingerprint,
    code,
    message,
    issues: [makeIssue(code, message)],
  };
}

// IMP-010B review round (B1 fix -- corrects a false claim in the original
// entry): this is now the SOLE row-classification authority in the ENTIRE
// codebase, browser included. `splitStrictVersionedCsvRows` above is the
// only piece of parsing that runs client-side, and it does ONLY byte
// decode/BOM-strip/row-splitting -- it produces unclassified `string[][]`
// and never calls this function. `app/components/import-review.tsx` never
// imports `classifyImportRows` at all (grep it; it only imports
// `splitStrictVersionedCsvRows`). Classification -- header validation,
// per-row grammar/enum/decimal rules, duplicate fingerprinting -- happens
// EXACTLY ONCE, HERE, on the SERVER, every time, for every upload. That is
// a STRONGER guarantee than "the browser and server both run the same
// function": there is no second, independently-invoked execution of this
// logic anywhere to ever disagree with this one, and a hostile payload
// that skips the browser's `splitStrictVersionedCsvRows` entirely still
// hits the identical, only-ever-server-side classification path a genuine
// upload's rows pass through -- never a simplified or bypassable re-check.
// `rows`/`fileFingerprint` are BOTH untrusted input at this boundary
// (AGENTS.md): a hand-crafted hostile payload must be rejected exactly as
// the equivalent malformed CSV text would have been rejected by the
// pre-IMP-010B server-side text parser. The size/count/content bounds
// checked immediately below re-enforce the SAME limits
// `splitStrictVersionedCsvRows`'s character-level parser already enforces,
// since nothing guarantees an untrusted `rows` payload ever passed through
// that parser at all -- including, per the review's B2/fold-4 finding, the
// original raw-CSV BYTE-VOLUME cap (`limits.maxBytes`): row-count and
// per-field-length bounds alone do not bound total volume (up to `maxRows`
// rows each near `maxFieldLength` could otherwise total far more than
// `maxBytes` while passing both individually), so this reconstructs the
// equivalent CSV text and measures its real encoded size too.
export async function classifyImportRows(
  rows: readonly (readonly string[])[],
  limits: ImportLimits,
  fileFingerprint: string,
): Promise<ImportParseResult> {
  if (rows.length > limits.maxRows + 1) {
    return createRowSplitFailure(
      fileFingerprint,
      "ROW_LIMIT_EXCEEDED",
      rowLimitExceededMessage(limits),
    );
  }

  for (const row of rows) {
    for (const field of row) {
      if (field.length > limits.maxFieldLength) {
        return createRowSplitFailure(
          fileFingerprint,
          "FIELD_LIMIT_EXCEEDED",
          fieldLimitExceededMessage(limits),
        );
      }
      if (field.includes(NUL_CHARACTER)) {
        return createRowSplitFailure(
          fileFingerprint,
          "CSV_DECODE_FAILED",
          NUL_OR_BINARY_MESSAGE,
        );
      }
    }
  }

  // Bounded by the row-count/field-length checks just above (already
  // enforced) AND by `app/import-request-body.ts`'s
  // `MAX_IMPORT_UPLOAD_REQUEST_BYTES` request-body ceiling (already
  // enforced before this function is ever reached from the server action)
  // -- this reconstruction and its single `TextEncoder` call therefore run
  // over already-small (well under `MAX_IMPORT_UPLOAD_REQUEST_BYTES`) data,
  // one linear pass, genuinely cheap. Joined with a single `\n` per row
  // (1 byte) rather than `\r\n` (2) or the original quoting -- a
  // DELIBERATE UNDER-estimate: every real line terminator this parser
  // accepts (`\n`, `\r`, `\r\n`) is at least 1 byte, and dropped quote
  // characters only shrink the reconstruction further, so this can never
  // exceed the TRUE original byte size. That keeps this check a pure
  // LOWER BOUND: it can only ever reject a payload that is AT LEAST this
  // large (never a false positive against a file that legitimately passed
  // `splitStrictVersionedCsvRows`'s own exact byte check), at the cost of
  // a small amount of slack against a hostile payload trying to sneak
  // marginally over `maxBytes` -- an accepted tradeoff, since the request
  // body's own ceiling remains the hard backstop regardless.
  const reconstructedCsvBytes = new TextEncoder().encode(
    rows.map((row) => row.join(",")).join("\n"),
  ).length;
  if (reconstructedCsvBytes > limits.maxBytes) {
    return createRowSplitFailure(
      fileFingerprint,
      "CSV_IMPORT_TOO_LARGE",
      csvTooLargeMessage(limits),
    );
  }

  if (rows.length === 0) {
    const header: ImportHeaderReport = {
      parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
      observedHeaders: [],
      normalizedHeaders: [],
      missingHeaders: [...SUPPORTED_IMPORT_HEADER],
      unknownHeaders: [],
      duplicateHeaders: [],
      signature: "",
    };
    return createHeaderMismatchFailure(
      fileFingerprint,
      header,
      "The CSV is missing the supported 17-column header.",
    );
  }

  const headerValidation = validateHeader([...(rows[0] ?? [])]);
  if (!headerValidation.ok) {
    return createHeaderMismatchFailure(
      fileFingerprint,
      headerValidation.header,
      "The CSV header does not match the supported 17-column import contract.",
    );
  }

  let bodyStartIndex = 1;
  while (
    bodyStartIndex < rows.length &&
    isBlankRow(rows[bodyStartIndex] as string[])
  ) {
    bodyStartIndex += 1;
  }

  const parsedRows: ParsedImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seenFingerprints = new Map<string, number>();
  let blankRows = 0;
  let definitionRows = 0;
  let transactionRows = 0;
  let unsupportedRows = 0;
  let cashTransactionRows = 0;
  let dividendRows = 0;
  let duplicateRows = 0;

  for (let index = bodyStartIndex; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    const row = rows[index] ? [...(rows[index] as string[])] : [];
    const classification = classifyRow(
      row,
      headerValidation.headerIndex,
      rowNumber,
      headerValidation.header.normalizedHeaders.length,
    );
    const fingerprintSource = normalizeRowForFingerprint(
      classification.normalized,
    );
    const fingerprint = await sha256Hex(
      new TextEncoder().encode(fingerprintSource),
    );

    if (classification.kind !== "blank") {
      const previousRowNumber = seenFingerprints.get(fingerprint);
      if (previousRowNumber !== undefined) {
        classification.issues = [
          ...classification.issues,
          makeIssue(
            "DUPLICATE_EXACT",
            `The row duplicates physical row ${previousRowNumber}.`,
            rowNumber,
          ),
        ];
        duplicateRows += 1;
      } else {
        seenFingerprints.set(fingerprint, rowNumber);
      }
    }

    switch (classification.kind) {
      case "blank":
        blankRows += 1;
        break;
      case "definition":
        definitionRows += 1;
        break;
      case "transaction":
        transactionRows += 1;
        if (classification.normalized.cashEvent !== null) {
          cashTransactionRows += 1;
        }
        if (classification.normalized.type === "dividend") {
          dividendRows += 1;
        }
        break;
      case "unsupported":
        unsupportedRows += 1;
        break;
    }

    issues.push(...classification.issues);
    parsedRows.push({
      rowNumber,
      kind: classification.kind,
      rawFields: row,
      normalized: classification.normalized,
      issues: classification.issues,
      fingerprint,
    });
  }

  return {
    ok: true,
    parserVersion: headerValidation.header.parserVersion,
    fileFingerprint,
    header: headerValidation.header,
    rows: parsedRows,
    issues,
    summary: {
      totalRows: parsedRows.length,
      blankRows,
      definitionRows,
      transactionRows,
      unsupportedRows,
      cashTransactionRows,
      dividendRows,
      duplicateRows,
    },
  };
}

export async function parseStrictVersionedCsvImport(
  source: string | Uint8Array,
  options: {
    maxBytes?: number;
    maxRows?: number;
    maxFieldLength?: number;
  } = {},
): Promise<ImportParseResult> {
  const limits: ImportLimits = {
    maxBytes: options.maxBytes ?? DEFAULT_IMPORT_LIMITS.maxBytes,
    maxRows: options.maxRows ?? DEFAULT_IMPORT_LIMITS.maxRows,
    maxFieldLength:
      options.maxFieldLength ?? DEFAULT_IMPORT_LIMITS.maxFieldLength,
  };

  const split = await splitStrictVersionedCsvRows(source, limits);
  if (!split.ok) {
    if (split.code === "CSV_IMPORT_TOO_LARGE") {
      return createUploadTooLargeFailure(split.fileFingerprint, split.message);
    }
    return createRowSplitFailure(
      split.fileFingerprint,
      split.code,
      split.message,
    );
  }

  return await classifyImportRows(split.rows, limits, split.fileFingerprint);
}

export function isSupportedImportFieldName(
  value: string,
): value is ImportFieldName {
  return SUPPORTED_FIELD_SET.has(value as ImportFieldName);
}
