// BRK-003: defensive `unknown` -> typed parsing for Sharesight v3 endpoint
// responses, mirroring `domain/market-data/normalize.ts` and
// `yahoo-compatible.ts`'s `positiveDecimal` conventions -- money/quantity
// fields become decimal STRINGS (AGENTS.md non-negotiable) parsed from
// whatever shape (JSON number or string) the provider actually sends,
// never JavaScript binary floating point used for arithmetic. Any envelope
// or item that doesn't validate returns an explicit `invalid_response`
// result; nothing here silently defaults a missing money/quantity field to
// zero.
//
// Absent vs malformed (BRK-003 review finding F1): for an OPTIONAL
// money/quantity field, `optionalDecimal` distinguishes a field that is
// genuinely absent/null (an honest "unknown" -> `null`) from one that is
// PRESENT but fails to parse as a decimal (e.g. a corrupt franking figure).
// The latter is never silently treated the same as "unknown" -- it fails
// the whole item closed (`invalid_response`), because several of these
// optional fields (franked/unfranked amounts, withheld tax) feed downstream
// tax assumptions, and a silently-dropped-to-null corrupt value there would
// be worse than an explicit failure.

import type {
  SharesightError,
  SharesightHolding,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
  SharesightTradeType,
} from "./contracts.ts";

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

/** `String(value)` for a finite number, mirroring
 * `yahoo-compatible.ts`'s `positiveDecimal` conversion. Money/quantity
 * fields on Sharesight endpoints may arrive as either a JSON number or a
 * decimal string; both are normalized to a canonical decimal string here. */
function decimalString(
  value: unknown,
  { allowNegative }: { allowNegative: boolean },
): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    if (!allowNegative && value < 0) {
      return null;
    }
    // TODO(BRK-008): String(value) can render a very large/small finite
    // number in exponential notation (e.g. 1e21); confirm real Sharesight
    // money/quantity magnitudes against a live response before assuming
    // this can't happen for a live field.
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const pattern = allowNegative
    ? /^-?(0|[1-9]\d*)(\.\d+)?$/
    : /^(0|[1-9]\d*)(\.\d+)?$/;
  return pattern.test(trimmed) ? trimmed : null;
}

function requiredDecimal(
  record: RecordValue,
  field: string,
  options: { allowNegative: boolean } = { allowNegative: false },
): string | null {
  return decimalString(record[field], options);
}

/** Sentinel distinguishing "field present but fails to parse as a decimal"
 * from a genuinely absent/null field (`null`, an honest "unknown"). Callers
 * MUST check for this sentinel and fail the whole item closed -- never
 * treat it the same as `null` (BRK-003 review finding F1). */
const MALFORMED_OPTIONAL_DECIMAL = Symbol(
  "sharesight-malformed-optional-decimal",
);

function optionalDecimal(
  record: RecordValue,
  field: string,
  options: { allowNegative: boolean } = { allowNegative: false },
): string | null | typeof MALFORMED_OPTIONAL_DECIMAL {
  const value = record[field];
  if (value === undefined || value === null) {
    return null; // genuinely absent -- an honest "unknown"
  }
  const parsed = decimalString(value, options);
  return parsed === null ? MALFORMED_OPTIONAL_DECIMAL : parsed;
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

function invalid(message: string): SharesightResult<never> {
  const error: SharesightError = {
    kind: "invalid_response",
    message,
    retryable: false,
  };
  return { ok: false, error };
}

function parseItemList<T>(
  root: unknown,
  envelopeKey: string,
  parseItem: (item: unknown) => T | null,
  itemLabel: string,
): SharesightResult<T[]> {
  const record = asRecord(root);
  const rawList = record ? record[envelopeKey] : null;
  if (!Array.isArray(rawList)) {
    return invalid(`Sharesight response is missing a "${envelopeKey}" list.`);
  }
  const items: T[] = [];
  for (const rawItem of rawList) {
    const parsed = parseItem(rawItem);
    if (parsed === null) {
      return invalid(
        `Sharesight ${itemLabel} response contains a malformed entry.`,
      );
    }
    items.push(parsed);
  }
  return { ok: true, value: items };
}

function parsePortfolioItem(item: unknown): SharesightPortfolio | null {
  const record = asRecord(item);
  if (!record) return null;
  // TODO(BRK-008): "id" is assumed to be a string here, and for trade/payout
  // ids below; confirm the real numeric-vs-string Sharesight v3 ID shape
  // against a live response before this assumption ships past the spike.
  const id = requiredString(record, "id");
  const name = requiredString(record, "name");
  const currencyCode = requiredString(record, "currency");
  if (!id || !name || !currencyCode) return null;
  return { id, name, currencyCode };
}

export function parseSharesightPortfolios(
  root: unknown,
): SharesightResult<SharesightPortfolio[]> {
  return parseItemList(root, "portfolios", parsePortfolioItem, "portfolios");
}

function instrumentFields(record: RecordValue): {
  instrumentCode: string;
  marketCode: string | null;
  currencyCode: string;
} | null {
  const instrument = asRecord(record.instrument);
  if (!instrument) return null;
  const instrumentCode = requiredString(instrument, "code");
  const currencyCode = requiredString(instrument, "currency");
  if (!instrumentCode || !currencyCode) return null;
  const marketCode = optionalString(instrument, "market");
  return { instrumentCode, marketCode, currencyCode };
}

function parseHoldingItem(
  item: unknown,
  portfolioId: string,
): SharesightHolding | null {
  const record = asRecord(item);
  if (!record) return null;
  const instrument = instrumentFields(record);
  if (!instrument) return null;
  const quantityDecimal = requiredDecimal(record, "quantity", {
    allowNegative: false,
  });
  if (!quantityDecimal) return null;
  const averageCostDecimal = optionalDecimal(record, "average_cost");
  if (averageCostDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  const marketValueDecimal = optionalDecimal(record, "market_value");
  if (marketValueDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  return {
    portfolioId,
    instrumentCode: instrument.instrumentCode,
    marketCode: instrument.marketCode,
    currencyCode: instrument.currencyCode,
    quantityDecimal,
    averageCostDecimal,
    marketValueDecimal,
  };
}

export function parseSharesightHoldings(
  root: unknown,
  portfolioId: string,
): SharesightResult<SharesightHolding[]> {
  return parseItemList(
    root,
    "holdings",
    (item) => parseHoldingItem(item, portfolioId),
    "holdings",
  );
}

const TRADE_TYPES = new Set(["buy", "sell", "other"]);

function parseTradeType(value: unknown): SharesightTradeType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return TRADE_TYPES.has(normalized)
    ? (normalized as SharesightTradeType)
    : null;
}

function parseTradeItem(
  item: unknown,
  portfolioId: string,
): SharesightTrade | null {
  const record = asRecord(item);
  if (!record) return null;
  const id = requiredString(record, "id");
  const instrument = instrumentFields(record);
  const transactionType = parseTradeType(record.transaction_type);
  const transactionDate = requiredString(record, "transaction_date");
  const quantityDecimal = requiredDecimal(record, "quantity", {
    allowNegative: false,
  });
  const priceDecimal = requiredDecimal(record, "price", {
    allowNegative: false,
  });
  if (
    !id ||
    !instrument ||
    !transactionType ||
    !transactionDate ||
    !isMarketDate(transactionDate) ||
    !quantityDecimal ||
    !priceDecimal
  ) {
    return null;
  }
  const brokerageDecimal = optionalDecimal(record, "brokerage");
  if (brokerageDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  return {
    id,
    portfolioId,
    instrumentCode: instrument.instrumentCode,
    marketCode: instrument.marketCode,
    transactionType,
    transactionDate,
    currencyCode: instrument.currencyCode,
    quantityDecimal,
    priceDecimal,
    brokerageDecimal,
  };
}

export function parseSharesightTrades(
  root: unknown,
  portfolioId: string,
): SharesightResult<SharesightTrade[]> {
  return parseItemList(
    root,
    "trades",
    (item) => parseTradeItem(item, portfolioId),
    "trades",
  );
}

function parsePayoutItem(
  item: unknown,
  portfolioId: string,
): SharesightPayout | null {
  const record = asRecord(item);
  if (!record) return null;
  const id = requiredString(record, "id");
  const instrument = instrumentFields(record);
  const paidOnDate = requiredString(record, "paid_on");
  const amountDecimal = requiredDecimal(record, "amount", {
    allowNegative: false,
  });
  if (
    !id ||
    !instrument ||
    !paidOnDate ||
    !isMarketDate(paidOnDate) ||
    !amountDecimal
  ) {
    return null;
  }
  // Franking/withholding figures feed downstream tax assumptions -- a
  // present-but-corrupt value must fail the item closed, never silently
  // become an honest "unknown" (BRK-003 review finding F1).
  const frankedAmountDecimal = optionalDecimal(record, "franked_amount");
  if (frankedAmountDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  const unfrankedAmountDecimal = optionalDecimal(record, "unfranked_amount");
  if (unfrankedAmountDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  const taxWithheldDecimal = optionalDecimal(
    record,
    "resident_withholding_tax",
  );
  if (taxWithheldDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  return {
    id,
    portfolioId,
    instrumentCode: instrument.instrumentCode,
    paidOnDate,
    currencyCode: instrument.currencyCode,
    amountDecimal,
    frankedAmountDecimal,
    unfrankedAmountDecimal,
    taxWithheldDecimal,
  };
}

export function parseSharesightPayouts(
  root: unknown,
  portfolioId: string,
): SharesightResult<SharesightPayout[]> {
  return parseItemList(
    root,
    "payouts",
    (item) => parsePayoutItem(item, portfolioId),
    "payouts",
  );
}
