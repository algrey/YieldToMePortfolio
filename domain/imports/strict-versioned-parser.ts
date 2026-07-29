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
  | "CSV_IMPORT_DISABLED"
  | "CSV_IMPORT_TOO_LARGE"
  | "ROW_LIMIT_EXCEEDED"
  | "FIELD_LIMIT_EXCEEDED"
  | "CSV_DECODE_FAILED";

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
  | "notes";

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
  "buy" | "sell" | "cash_deposit" | "cash_withdrawal";

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

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxRows: 100_000,
  maxFieldLength: 1024 * 1024,
};

const SUPPORTED_HEADER_SET = new Set<string>([...SUPPORTED_IMPORT_HEADER]);

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
};

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
        message: "A CSV field exceeded the configured size limit.",
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
        message: "The CSV exceeded the configured row limit.",
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
          message: "A CSV field exceeded the configured size limit.",
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
        message: "A CSV field exceeded the configured size limit.",
      };
    }
  }

  if (inQuotes) {
    return {
      ok: false,
      code: "CSV_DECODE_FAILED",
      message: "The CSV contains an unterminated quoted field.",
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

function validateHeader(rawHeader: string[]): HeaderValidationResult {
  const normalizedHeaders = rawHeader.map((header) =>
    normalizeHeaderCell(header),
  );
  const observedHeaders = rawHeader.map((header) => header);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknownHeaders: string[] = [];

  for (const header of normalizedHeaders) {
    if (seen.has(header)) {
      if (SUPPORTED_HEADER_SET.has(header)) {
        duplicates.add(header);
      }
    } else {
      seen.add(header);
    }

    if (!SUPPORTED_HEADER_SET.has(header)) {
      unknownHeaders.push(header);
    }
  }

  const missingHeaders = SUPPORTED_IMPORT_HEADER.filter(
    (header) => !seen.has(header),
  );

  const header: ImportHeaderReport = {
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    observedHeaders,
    normalizedHeaders,
    missingHeaders,
    unknownHeaders,
    duplicateHeaders: [...duplicates],
    signature: normalizedHeaders.join("\u001f"),
  };

  if (
    normalizedHeaders.length !== SUPPORTED_IMPORT_HEADER.length ||
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
  ].join("|");
}

function classifyRow(
  row: string[],
  headerIndex: Map<ImportFieldName, number>,
  rowNumber: number,
): RowClassification {
  const normalized = createNormalizedRow(row, headerIndex);
  const issues: ImportIssue[] = [];

  if (isBlankRow(row)) {
    return { kind: "blank", issues, normalized };
  }

  if (row.length !== SUPPORTED_IMPORT_HEADER.length) {
    issues.push(
      makeIssue(
        "COLUMN_COUNT",
        "The row does not contain the supported 17-column shape.",
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

  const bytes = toBytes(source);
  const fileFingerprint = await sha256Hex(bytes);

  if (bytes.byteLength > limits.maxBytes) {
    return createUploadTooLargeFailure(
      fileFingerprint,
      "The CSV upload exceeds the configured size limit.",
    );
  }

  const decoded = decodeUtf8(bytes);
  if (decoded === null) {
    return {
      ok: false,
      parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
      fileFingerprint,
      code: "CSV_DECODE_FAILED",
      message: "The supplied CSV is not valid UTF-8.",
      issues: [
        makeIssue("CSV_DECODE_FAILED", "The supplied CSV is not valid UTF-8."),
      ],
    };
  }

  const rowsResult = parseCsvText(stripBom(decoded), limits);
  if (!rowsResult.ok) {
    return {
      ok: false,
      parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
      fileFingerprint,
      code: rowsResult.code,
      message: rowsResult.message,
      issues: [makeIssue(rowsResult.code, rowsResult.message)],
    };
  }

  if (rowsResult.rows.length === 0) {
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

  const headerValidation = validateHeader(rowsResult.rows[0] ?? []);
  if (!headerValidation.ok) {
    return createHeaderMismatchFailure(
      fileFingerprint,
      headerValidation.header,
      "The CSV header does not match the supported 17-column import contract.",
    );
  }

  let bodyStartIndex = 1;
  while (
    bodyStartIndex < rowsResult.rows.length &&
    isBlankRow(rowsResult.rows[bodyStartIndex] ?? [])
  ) {
    bodyStartIndex += 1;
  }

  const rows: ParsedImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seenFingerprints = new Map<string, number>();
  let blankRows = 0;
  let definitionRows = 0;
  let transactionRows = 0;
  let unsupportedRows = 0;
  let cashTransactionRows = 0;
  let duplicateRows = 0;

  for (let index = bodyStartIndex; index < rowsResult.rows.length; index += 1) {
    const rowNumber = index + 1;
    const row = rowsResult.rows[index] ? [...rowsResult.rows[index]] : [];
    const classification = classifyRow(
      row,
      headerValidation.headerIndex,
      rowNumber,
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
        break;
      case "unsupported":
        unsupportedRows += 1;
        break;
    }

    issues.push(...classification.issues);
    rows.push({
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
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    fileFingerprint,
    header: headerValidation.header,
    rows,
    issues,
    summary: {
      totalRows: rows.length,
      blankRows,
      definitionRows,
      transactionRows,
      unsupportedRows,
      cashTransactionRows,
      duplicateRows,
    },
  };
}

export function isSupportedImportFieldName(
  value: string,
): value is ImportFieldName {
  return SUPPORTED_FIELD_SET.has(value as ImportFieldName);
}
