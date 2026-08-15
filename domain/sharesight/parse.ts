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

/**
 * `String(value)` for a finite number, mirroring `yahoo-compatible.ts`'s
 * `positiveDecimal` conversion. Money/quantity fields on Sharesight
 * endpoints may arrive as either a JSON number or a decimal string; both are
 * normalized to a canonical decimal string here.
 *
 * BRK-008 decision (2026-08-15, resolves the former exponent TODO --
 * see `docs/ARCHITECTURE.md` §8.2): Sharesight emits money/quantity fields
 * as JSON floats, so conversion is an EXACT double round-trip --
 * `String(value)` on any finite JS number is guaranteed by ECMA-262 to
 * produce the shortest string that parses back to the exact same value, so
 * this never fabricates precision the wire didn't carry. The one thing
 * `String()` can produce that is NOT a valid decimal string is exponential
 * notation for a very large/small magnitude (e.g. `"1e+21"`); that is
 * REJECTED (returns `null`, fail-closed) rather than reformatted, since
 * reformatting would itself be inventing a representation Sharesight never
 * sent. `NaN`/`Infinity` are rejected the same way via `Number.isFinite`.
 * Net effect: our precision is bounded by exactly what Sharesight's own
 * float emission carries on the wire -- we preserve it exactly, we never
 * extend or reformat it.
 */
function decimalString(
  value: unknown,
  { allowNegative }: { allowNegative: boolean },
): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null; // rejects NaN/Infinity, fail-closed
    }
    if (!allowNegative && value < 0) {
      return null;
    }
    const rendered = String(value);
    if (/e/i.test(rendered)) {
      return null; // exponential notation is not a valid decimal string
    }
    return rendered;
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

/** Sentinel distinguishing "field present but not a (non-empty) string" from
 * a genuinely absent/null field (`null`, an honest "unknown"). Mirrors
 * `MALFORMED_OPTIONAL_DECIMAL`'s absent-vs-malformed discipline (BRK-003
 * review finding F1) for optional STRING fields: callers MUST check for this
 * sentinel and fail the whole item closed -- never treat it the same as
 * `null`. Used by `parsePortfolioItem`'s optional fields (e.g. `tz_name`,
 * `cg_discount`) and, as of the BRK-008 live pass, `parseTradeItem`'s
 * optional string fields too (e.g. `state`, `unique_identifier`,
 * `description_code`, `source_category`, `brokerage_currency_code`,
 * `exchange_rate_pair`, `paid_on`). */
const MALFORMED_OPTIONAL_STRING = Symbol(
  "sharesight-malformed-optional-string",
);

function optionalStringField(
  record: RecordValue,
  field: string,
): string | null | typeof MALFORMED_OPTIONAL_STRING {
  const value = record[field];
  if (value === undefined || value === null) {
    return null; // genuinely absent/null -- an honest "unknown"
  }
  if (typeof value !== "string") {
    return MALFORMED_OPTIONAL_STRING; // present, wrong type -- fails item closed
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** ISO 4217-shaped currency code: exactly 3 uppercase letters, matching this
 * module's `currencyCode` convention elsewhere (`SharesightHolding`,
 * `SharesightTrade`, `SharesightPayout`). */
function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/** Normalizes a REQUIRED numeric Sharesight v3 id (confirmed live shape,
 * 2026-08-15 -- see docs/ARCHITECTURE.md §8.2) to a canonical decimal
 * string: `String(value)` renders any integer up to
 * `Number.MAX_SAFE_INTEGER` exactly, with no exponential notation or
 * precision loss, so a non-negative safe integer is the only value accepted.
 * A non-integer, negative, non-finite, or unsafe (beyond
 * `Number.MAX_SAFE_INTEGER`) value returns `null` and fails the item closed
 * -- this resolves the former TODO(BRK-008) numeric-vs-string id assumption
 * for portfolios. */
function requiredIntegerIdDecimalString(
  record: RecordValue,
  field: string,
): string | null {
  const value = record[field];
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value)) return null; // also rejects NaN/Infinity
  if (!Number.isSafeInteger(value)) return null;
  if (value < 0) return null;
  return String(value);
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
  // Live-confirmed 2026-08-15 (docs/ARCHITECTURE.md §8.2): portfolio ids are
  // numeric integers, not strings. `requiredIntegerIdDecimalString`
  // normalizes to a decimal string, rejecting non-integer/unsafe values.
  const id = requiredIntegerIdDecimalString(record, "id");
  const name = requiredString(record, "name");
  const currencyCodeRaw = requiredString(record, "currency_code");
  const currencyCode =
    currencyCodeRaw && isCurrencyCode(currencyCodeRaw) ? currencyCodeRaw : null;
  if (!id || !name || !currencyCode) return null;

  // OPTIONAL fields: present-but-null and genuinely-absent are both an
  // honest "unknown" (`null`); a present-but-wrong-type value fails the
  // whole item closed rather than silently collapsing to "unknown" (mirrors
  // this module's absent-vs-malformed discipline for optional decimals,
  // BRK-003 review finding F1). `cg_discount` is intentionally left as an
  // OPAQUE string here -- never parsed/interpreted as a number or
  // percentage.
  const inceptionDate = optionalStringField(record, "inception_date");
  const tzName = optionalStringField(record, "tz_name");
  const accessLevel = optionalStringField(record, "access_level");
  const financialYearEnd = optionalStringField(record, "financial_year_end");
  const cgDiscount = optionalStringField(record, "cg_discount");
  const countryCode = optionalStringField(record, "country_code");
  const ownerName = optionalStringField(record, "owner_name");
  const taxEntityType = optionalStringField(record, "tax_entity_type");
  if (
    inceptionDate === MALFORMED_OPTIONAL_STRING ||
    tzName === MALFORMED_OPTIONAL_STRING ||
    accessLevel === MALFORMED_OPTIONAL_STRING ||
    financialYearEnd === MALFORMED_OPTIONAL_STRING ||
    cgDiscount === MALFORMED_OPTIONAL_STRING ||
    countryCode === MALFORMED_OPTIONAL_STRING ||
    ownerName === MALFORMED_OPTIONAL_STRING ||
    taxEntityType === MALFORMED_OPTIONAL_STRING
  ) {
    return null;
  }

  return {
    id,
    name,
    currencyCode,
    inceptionDate,
    tzName,
    accessLevel,
    financialYearEnd,
    cgDiscount,
    countryCode,
    ownerName,
    taxEntityType,
  };
}

export function parseSharesightPortfolios(
  root: unknown,
): SharesightResult<SharesightPortfolio[]> {
  return parseItemList(root, "portfolios", parsePortfolioItem, "portfolios");
}

/**
 * Live-confirmed shape (2026-08-15, owner's real account -- see
 * `docs/ARCHITECTURE.md` §8.2): the nested `instrument` object's resolution
 * keys are `code`, `market_code`, and `currency_code` -- NOT `market`/
 * `currency` as BRK-003 originally assumed. All three are REQUIRED: they
 * are the exact keys BRK-005's security resolution needs (ticker +
 * exchange/MIC + currency), so a holding/trade/payout item missing any of
 * them fails closed rather than resolving against an incomplete key.
 * Validated shallowly -- only these three fields are read; every other key
 * on the live `instrument` object (`country_id`, `crypto`, `expired`,
 * `logo`, `classifications`, etc.) is ignored, not validated or retained.
 */
function instrumentFields(record: RecordValue): {
  instrumentCode: string;
  marketCode: string;
  currencyCode: string;
} | null {
  const instrument = asRecord(record.instrument);
  if (!instrument) return null;
  const instrumentCode = requiredString(instrument, "code");
  const marketCode = requiredString(instrument, "market_code");
  const currencyCode = requiredString(instrument, "currency_code");
  if (!instrumentCode || !marketCode || !currencyCode) return null;
  return { instrumentCode, marketCode, currencyCode };
}

function parseHoldingItem(
  item: unknown,
  portfolioId: string,
): SharesightHolding | null {
  const record = asRecord(item);
  if (!record) return null;
  // Live-confirmed 2026-08-15: `id` is a numeric integer (portfolios
  // technique) and a top-level `symbol` field is present alongside
  // `instrument.code`.
  const id = requiredIntegerIdDecimalString(record, "id");
  const symbol = requiredString(record, "symbol");
  const instrument = instrumentFields(record);
  if (!id || !symbol || !instrument) return null;
  // OPTIONAL, not required -- the confirmed live `HoldingPortfolioList`
  // response carries no quantity/value field at all on this endpoint (see
  // `SharesightHolding`'s doc comment); a present-but-unparseable value
  // still fails the item closed (absent-vs-malformed discipline).
  const quantityDecimal = optionalDecimal(record, "quantity");
  if (quantityDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  const averageCostDecimal = optionalDecimal(record, "average_cost");
  if (averageCostDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  const marketValueDecimal = optionalDecimal(record, "market_value");
  if (marketValueDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  return {
    id,
    portfolioId,
    symbol,
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

/** Sentinel distinguishing "transaction_type present but not one of the
 * modelled enum values" from a genuinely absent/null field -- see
 * `SharesightTrade`'s doc comment. Mirrors this module's other
 * `MALFORMED_OPTIONAL_*` sentinels. */
const MALFORMED_TRADE_TYPE = Symbol("sharesight-malformed-trade-type");

/**
 * Live-confirmed 2026-08-15: `transaction_type` is OPTIONAL -- the live
 * response's first item did not carry this field at all. Absent/null is an
 * honest "unknown"; a present value outside `buy`/`sell`/`other` fails the
 * item closed rather than being silently treated the same as "unknown"
 * (absent-vs-malformed discipline, BRK-003 review finding F1).
 */
function optionalTradeType(
  record: RecordValue,
): SharesightTradeType | null | typeof MALFORMED_TRADE_TYPE {
  const value = record.transaction_type;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return MALFORMED_TRADE_TYPE;
  const normalized = value.trim().toLowerCase();
  return TRADE_TYPES.has(normalized)
    ? (normalized as SharesightTradeType)
    : MALFORMED_TRADE_TYPE;
}

function parseTradeItem(
  item: unknown,
  portfolioId: string,
): SharesightTrade | null {
  const record = asRecord(item);
  if (!record) return null;
  // Live-confirmed 2026-08-15: trade `id` is a numeric integer, like
  // portfolios/holdings -- not a string as BRK-003 originally assumed.
  const id = requiredIntegerIdDecimalString(record, "id");
  const instrument = instrumentFields(record);
  const transactionType = optionalTradeType(record);
  if (transactionType === MALFORMED_TRADE_TYPE) return null;
  const transactionDate = requiredString(record, "transaction_date");
  const quantityDecimal = requiredDecimal(record, "quantity", {
    allowNegative: false,
  });
  const priceDecimal = requiredDecimal(record, "price", {
    allowNegative: false,
  });
  const holdingId = requiredIntegerIdDecimalString(record, "holding_id");
  // Real cross-check, not a reworded no-op (Orchestrator ruling): the trade
  // item's OWN `portfolio_id` must be present, well-shaped, AND EQUAL to the
  // caller-supplied `portfolioId` this fetch was scoped to. A mismatch fails
  // the item closed via the envelope's whole-item fail-close convention
  // (never silently re-attributed to the queried portfolio) -- a
  // mis-scoped record silently accepted here would be a provenance lie
  // downstream (AGENTS.md: never trust a self-reported owner/scope over the
  // authenticated context it was fetched under).
  const recordPortfolioId = requiredIntegerIdDecimalString(
    record,
    "portfolio_id",
  );
  if (
    !id ||
    !instrument ||
    !transactionDate ||
    !isMarketDate(transactionDate) ||
    !quantityDecimal ||
    !priceDecimal ||
    !holdingId ||
    !recordPortfolioId ||
    recordPortfolioId !== portfolioId
  ) {
    return null;
  }
  const valueDecimal = optionalDecimal(record, "value");
  if (valueDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  const brokerageDecimal = optionalDecimal(record, "brokerage");
  if (brokerageDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;
  const exchangeRateDecimal = optionalDecimal(record, "exchange_rate");
  if (exchangeRateDecimal === MALFORMED_OPTIONAL_DECIMAL) return null;

  const brokerageCurrencyCode = optionalStringField(
    record,
    "brokerage_currency_code",
  );
  const exchangeRatePair = optionalStringField(record, "exchange_rate_pair");
  const state = optionalStringField(record, "state");
  const uniqueIdentifier = optionalStringField(record, "unique_identifier");
  const paidOnDate = optionalStringField(record, "paid_on");
  const descriptionCode = optionalStringField(record, "description_code");
  const sourceCategory = optionalStringField(record, "source_category");
  if (
    brokerageCurrencyCode === MALFORMED_OPTIONAL_STRING ||
    exchangeRatePair === MALFORMED_OPTIONAL_STRING ||
    state === MALFORMED_OPTIONAL_STRING ||
    uniqueIdentifier === MALFORMED_OPTIONAL_STRING ||
    paidOnDate === MALFORMED_OPTIONAL_STRING ||
    descriptionCode === MALFORMED_OPTIONAL_STRING ||
    sourceCategory === MALFORMED_OPTIONAL_STRING
  ) {
    return null;
  }

  return {
    id,
    portfolioId,
    holdingId,
    instrumentCode: instrument.instrumentCode,
    marketCode: instrument.marketCode,
    transactionType,
    transactionDate,
    currencyCode: instrument.currencyCode,
    quantityDecimal,
    priceDecimal,
    valueDecimal,
    brokerageDecimal,
    brokerageCurrencyCode,
    exchangeRateDecimal,
    exchangeRatePair,
    state,
    uniqueIdentifier,
    paidOnDate,
    descriptionCode,
    sourceCategory,
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
