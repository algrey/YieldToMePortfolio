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
  SharesightItemFailureReason,
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
 * `exchange_rate_pair`, `paid_on`, and, as of the BRK-008 2026-08-15
 * item #46/107 live pass, `comments`). */
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

function invalid(
  message: string,
  itemFailure?: {
    itemIndex: number;
    fieldName: string;
    reason: SharesightItemFailureReason;
  },
): SharesightResult<never> {
  const error: SharesightError = {
    kind: "invalid_response",
    message,
    retryable: false,
    ...(itemFailure ? { itemFailure } : {}),
  };
  return { ok: false, error };
}

/**
 * BRK-008 diagnostic (2026-08-15 follow-up): thrown by an item-parser (e.g.
 * `parsePortfolioItem`) at the exact point a single field fails validation,
 * carrying ONLY a static field NAME and a closed `SharesightItemFailureReason`
 * classification -- never the field's value. `parseItemList` is the only
 * place this is ever caught; it converts the throw into the `itemFailure`
 * detail on the returned `invalid_response` result (`invalid()` above).
 * Any OTHER exception an item-parser throws (a real bug, not a validation
 * failure) is deliberately left to propagate uncaught, rather than being
 * silently reinterpreted as a validation failure.
 */
class ItemFieldFailure extends Error {
  fieldName: string;
  reason: SharesightItemFailureReason;

  constructor(fieldName: string, reason: SharesightItemFailureReason) {
    super(
      `Sharesight item field "${fieldName}" failed validation (${reason}).`,
    );
    this.name = "ItemFieldFailure";
    this.fieldName = fieldName;
    this.reason = reason;
  }
}

/** Throws `ItemFieldFailure` for `fieldName`/`reason` -- see that class's doc
 * comment. Typed `never` so call sites read like the `return null` style
 * they replace (e.g. `if (!id) fail("id", ...)`). */
function fail(fieldName: string, reason: SharesightItemFailureReason): never {
  throw new ItemFieldFailure(fieldName, reason);
}

/**
 * Classifies why a REQUIRED field of the given expected JSON `typeof` failed
 * validation, by FORMAT CLASS only (never the field's value): absent/null is
 * `missing`; present but the wrong JS type is `wrong_type`; present as an
 * empty/whitespace-only string is treated as `missing` (an honest "unknown",
 * matching `requiredString`'s own absent-vs-empty convention); anything else
 * (a correctly-typed value that still fails a FURTHER validity check, e.g. a
 * non-integer id number) is `wrong_type` too -- the caller distinguishes a
 * more specific reason (`invalid_decimal`/`invalid_format`) itself when one
 * applies. Only ever called once the corresponding `required*` helper has
 * already returned `null` for this field, so it never has to re-derive
 * success.
 */
function requiredFailureReason(
  record: RecordValue,
  field: string,
  expectedType: "string" | "number",
): SharesightItemFailureReason {
  const value = record[field];
  if (value === undefined || value === null) return "missing";
  if (typeof value !== expectedType) return "wrong_type";
  if (expectedType === "string" && (value as string).trim().length === 0) {
    return "missing";
  }
  return "wrong_type";
}

/** Classifies why a REQUIRED decimal field failed: absent/null is `missing`;
 * anything present that didn't parse is `invalid_decimal` (covers both "not
 * decimal-shaped" and disallowed-sign cases -- both are a malformed decimal,
 * not a type mismatch). */
function requiredDecimalFailureReason(
  record: RecordValue,
  field: string,
): SharesightItemFailureReason {
  const value = record[field];
  return value === undefined || value === null ? "missing" : "invalid_decimal";
}

/**
 * Identifies which single field under `record.instrument` caused
 * `instrumentFields` to return `null` -- either `instrument` itself
 * (absent/null -> `missing`, present but not an object -> `wrong_type`), or
 * whichever of `code`/`market_code`/`currency_code` (checked in that order)
 * is the first to fail `requiredString`. `fieldName` uses a dotted path
 * (`"instrument.code"`) for the nested case -- still a static field NAME,
 * never a value. Only ever called once `instrumentFields(record)` has
 * already returned `null`, so by construction at least one of these checks
 * fails; the trailing fallback is unreachable in practice but keeps this
 * function total rather than assuming that invariant blindly.
 */
function instrumentFailureDetail(record: RecordValue): {
  fieldName: string;
  reason: SharesightItemFailureReason;
} {
  const rawInstrument = record.instrument;
  const instrument = asRecord(rawInstrument);
  if (!instrument) {
    return {
      fieldName: "instrument",
      reason:
        rawInstrument === undefined || rawInstrument === null
          ? "missing"
          : "wrong_type",
    };
  }
  for (const key of ["code", "market_code", "currency_code"] as const) {
    if (!requiredString(instrument, key)) {
      return {
        fieldName: `instrument.${key}`,
        reason: requiredFailureReason(instrument, key, "string"),
      };
    }
  }
  return { fieldName: "instrument", reason: "wrong_type" };
}

function parseItemList<T>(
  root: unknown,
  envelopeKey: string,
  parseItem: (item: unknown) => T,
  itemLabel: string,
): SharesightResult<T[]> {
  const record = asRecord(root);
  const rawList = record ? record[envelopeKey] : null;
  if (!Array.isArray(rawList)) {
    return invalid(`Sharesight response is missing a "${envelopeKey}" list.`);
  }
  const items: T[] = [];
  for (let itemIndex = 0; itemIndex < rawList.length; itemIndex += 1) {
    try {
      items.push(parseItem(rawList[itemIndex]));
    } catch (caught) {
      if (caught instanceof ItemFieldFailure) {
        return invalid(
          `Sharesight ${itemLabel} response contains a malformed entry.`,
          { itemIndex, fieldName: caught.fieldName, reason: caught.reason },
        );
      }
      throw caught; // a real bug in an item-parser, not a validation failure
    }
  }
  return { ok: true, value: items };
}

function parsePortfolioItem(item: unknown): SharesightPortfolio {
  const record = asRecord(item);
  if (!record) fail("<item>", "wrong_type");
  // Live-confirmed 2026-08-15 (docs/ARCHITECTURE.md §8.2): portfolio ids are
  // numeric integers, not strings. `requiredIntegerIdDecimalString`
  // normalizes to a decimal string, rejecting non-integer/unsafe values.
  const id = requiredIntegerIdDecimalString(record, "id");
  if (!id) fail("id", requiredFailureReason(record, "id", "number"));
  const name = requiredString(record, "name");
  if (!name) fail("name", requiredFailureReason(record, "name", "string"));
  const currencyCodeRaw = requiredString(record, "currency_code");
  if (!currencyCodeRaw) {
    fail(
      "currency_code",
      requiredFailureReason(record, "currency_code", "string"),
    );
  }
  if (!isCurrencyCode(currencyCodeRaw)) fail("currency_code", "invalid_format");
  const currencyCode = currencyCodeRaw;

  // OPTIONAL fields: present-but-null and genuinely-absent are both an
  // honest "unknown" (`null`); a present-but-wrong-type value fails the
  // whole item closed rather than silently collapsing to "unknown" (mirrors
  // this module's absent-vs-malformed discipline for optional decimals,
  // BRK-003 review finding F1). `cg_discount` is intentionally left as an
  // OPAQUE string here -- never parsed/interpreted as a number or
  // percentage.
  const inceptionDate = optionalStringField(record, "inception_date");
  if (inceptionDate === MALFORMED_OPTIONAL_STRING)
    fail("inception_date", "wrong_type");
  const tzName = optionalStringField(record, "tz_name");
  if (tzName === MALFORMED_OPTIONAL_STRING) fail("tz_name", "wrong_type");
  const accessLevel = optionalStringField(record, "access_level");
  if (accessLevel === MALFORMED_OPTIONAL_STRING)
    fail("access_level", "wrong_type");
  const financialYearEnd = optionalStringField(record, "financial_year_end");
  if (financialYearEnd === MALFORMED_OPTIONAL_STRING) {
    fail("financial_year_end", "wrong_type");
  }
  const cgDiscount = optionalStringField(record, "cg_discount");
  if (cgDiscount === MALFORMED_OPTIONAL_STRING)
    fail("cg_discount", "wrong_type");
  const countryCode = optionalStringField(record, "country_code");
  if (countryCode === MALFORMED_OPTIONAL_STRING)
    fail("country_code", "wrong_type");
  const ownerName = optionalStringField(record, "owner_name");
  if (ownerName === MALFORMED_OPTIONAL_STRING) fail("owner_name", "wrong_type");
  const taxEntityType = optionalStringField(record, "tax_entity_type");
  if (taxEntityType === MALFORMED_OPTIONAL_STRING)
    fail("tax_entity_type", "wrong_type");

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
): SharesightHolding {
  const record = asRecord(item);
  if (!record) fail("<item>", "wrong_type");
  // Live-confirmed 2026-08-15: `id` is a numeric integer (portfolios
  // technique) and a top-level `symbol` field is present alongside
  // `instrument.code`.
  const id = requiredIntegerIdDecimalString(record, "id");
  if (!id) fail("id", requiredFailureReason(record, "id", "number"));
  const symbol = requiredString(record, "symbol");
  if (!symbol)
    fail("symbol", requiredFailureReason(record, "symbol", "string"));
  const instrument = instrumentFields(record);
  if (!instrument) {
    const detail = instrumentFailureDetail(record);
    fail(detail.fieldName, detail.reason);
  }
  // OPTIONAL, not required -- the confirmed live `HoldingPortfolioList`
  // response carries no quantity/value field at all on this endpoint (see
  // `SharesightHolding`'s doc comment); a present-but-unparseable value
  // still fails the item closed (absent-vs-malformed discipline).
  const quantityDecimal = optionalDecimal(record, "quantity");
  if (quantityDecimal === MALFORMED_OPTIONAL_DECIMAL)
    fail("quantity", "invalid_decimal");
  const averageCostDecimal = optionalDecimal(record, "average_cost");
  if (averageCostDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("average_cost", "invalid_decimal");
  }
  const marketValueDecimal = optionalDecimal(record, "market_value");
  if (marketValueDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("market_value", "invalid_decimal");
  }
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

function parseTradeItem(item: unknown, portfolioId: string): SharesightTrade {
  const record = asRecord(item);
  if (!record) fail("<item>", "wrong_type");
  // Live-confirmed 2026-08-15: trade `id` is a numeric integer, like
  // portfolios/holdings -- not a string as BRK-003 originally assumed.
  const id = requiredIntegerIdDecimalString(record, "id");
  if (!id) fail("id", requiredFailureReason(record, "id", "number"));
  const instrument = instrumentFields(record);
  if (!instrument) {
    const detail = instrumentFailureDetail(record);
    fail(detail.fieldName, detail.reason);
  }
  const transactionType = optionalTradeType(record);
  if (transactionType === MALFORMED_TRADE_TYPE) {
    fail("transaction_type", "invalid_format");
  }
  const transactionDate = requiredString(record, "transaction_date");
  if (!transactionDate) {
    fail(
      "transaction_date",
      requiredFailureReason(record, "transaction_date", "string"),
    );
  }
  if (!isMarketDate(transactionDate))
    fail("transaction_date", "invalid_format");
  // BRK-008 live evidence (2026-08-15, item #46/107 -- see
  // docs/ARCHITECTURE.md §8.2): that item's `itemFailure` diagnostic reported
  // `fieldName: "value"`, NOT `"quantity"` -- and this function parses
  // `quantity` BEFORE `value` (see below), so item #46's `quantity` field
  // MUST have already passed the (then-unsigned-only) parse to reach the
  // `value` check at all. That LIVE-CONFIRMS a signed `value` (a sell is
  // negative); it proves NOTHING about `quantity`'s sign for that item, and
  // is certainly not evidence quantity is EVER negative. `allowNegative:
  // true` here is therefore an INFERENCE extrapolated from `value`'s
  // confirmed signedness (plausible: the two would ordinarily carry the same
  // sign), kept fail-open deliberately so a genuinely signed live `quantity`
  // does not re-block the whole list the way item #46 did -- but it remains
  // UNCONFIRMED pending a live item that actually exercises a negative
  // `quantity`. This SUPERSEDES BRK-003's original "quantity is always
  // non-negative" assumption; the BRK-008 §8.2 "no recoverable direction"
  // note is restated, not superseded: the CONFIRMED direction signal is
  // `value`'s sign, `quantity`'s sign is pending confirmation, and
  // `BRK-005` should treat it accordingly.
  const quantityDecimal = requiredDecimal(record, "quantity", {
    allowNegative: true,
  });
  if (!quantityDecimal)
    fail("quantity", requiredDecimalFailureReason(record, "quantity"));
  // `price` stays unsigned -- the only LIVE-CONFIRMED signed field is
  // `value` (item #46/107; `quantity`'s allowNegative above is an inference
  // extrapolated from that, not its own confirmation -- see the comment on
  // `quantityDecimal`). A sell's per-unit price is still a positive
  // magnitude either way (the trade's direction is expressed once, not
  // doubled onto price too). If live evidence ever shows a signed price,
  // this must be revisited the same way value was here, not assumed.
  const priceDecimal = requiredDecimal(record, "price", {
    allowNegative: false,
  });
  if (!priceDecimal)
    fail("price", requiredDecimalFailureReason(record, "price"));
  const holdingId = requiredIntegerIdDecimalString(record, "holding_id");
  if (!holdingId) {
    fail("holding_id", requiredFailureReason(record, "holding_id", "number"));
  }
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
  if (!recordPortfolioId) {
    fail(
      "portfolio_id",
      requiredFailureReason(record, "portfolio_id", "number"),
    );
  }
  if (recordPortfolioId !== portfolioId) fail("portfolio_id", "mismatch");

  // `value` is the LIVE-CONFIRMED signed field (item #46/107 carried a
  // negative `value` for what the previously-unsigned regex rejected as
  // `invalid_decimal`) -- `quantity`'s allowNegative above extrapolates FROM
  // this observation, not the reverse.
  const valueDecimal = optionalDecimal(record, "value", {
    allowNegative: true,
  });
  if (valueDecimal === MALFORMED_OPTIONAL_DECIMAL)
    fail("value", "invalid_decimal");
  // `brokerage` stays unsigned like `price` -- a brokerage FEE is a positive
  // magnitude; no live evidence has ever shown a negative brokerage value,
  // and inventing sign-tolerance here without evidence would risk silently
  // accepting a corrupt/negated fee.
  const brokerageDecimal = optionalDecimal(record, "brokerage");
  if (brokerageDecimal === MALFORMED_OPTIONAL_DECIMAL)
    fail("brokerage", "invalid_decimal");
  const exchangeRateDecimal = optionalDecimal(record, "exchange_rate");
  if (exchangeRateDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("exchange_rate", "invalid_decimal");
  }

  const brokerageCurrencyCode = optionalStringField(
    record,
    "brokerage_currency_code",
  );
  if (brokerageCurrencyCode === MALFORMED_OPTIONAL_STRING) {
    fail("brokerage_currency_code", "wrong_type");
  }
  const exchangeRatePair = optionalStringField(record, "exchange_rate_pair");
  if (exchangeRatePair === MALFORMED_OPTIONAL_STRING) {
    fail("exchange_rate_pair", "wrong_type");
  }
  const state = optionalStringField(record, "state");
  if (state === MALFORMED_OPTIONAL_STRING) fail("state", "wrong_type");
  const uniqueIdentifier = optionalStringField(record, "unique_identifier");
  if (uniqueIdentifier === MALFORMED_OPTIONAL_STRING) {
    fail("unique_identifier", "wrong_type");
  }
  const paidOnDate = optionalStringField(record, "paid_on");
  if (paidOnDate === MALFORMED_OPTIONAL_STRING) fail("paid_on", "wrong_type");
  const descriptionCode = optionalStringField(record, "description_code");
  if (descriptionCode === MALFORMED_OPTIONAL_STRING) {
    fail("description_code", "wrong_type");
  }
  const sourceCategory = optionalStringField(record, "source_category");
  if (sourceCategory === MALFORMED_OPTIONAL_STRING) {
    fail("source_category", "wrong_type");
  }
  // BRK-008 live evidence (2026-08-15, item #46/107 -- see
  // docs/ARCHITECTURE.md §8.2): `comments` is present as a string on some
  // trade items (item #1) and `null` on others (item #46) -- an honest
  // "unknown", not malformed. Null-tolerant per this module's optional-field
  // sentinel discipline: absent/null parses as `null`; present-but-wrong-type
  // fails the item closed.
  const comments = optionalStringField(record, "comments");
  if (comments === MALFORMED_OPTIONAL_STRING) fail("comments", "wrong_type");

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
    comments,
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

function parsePayoutItem(item: unknown, portfolioId: string): SharesightPayout {
  const record = asRecord(item);
  if (!record) fail("<item>", "wrong_type");
  const id = requiredString(record, "id");
  if (!id) fail("id", requiredFailureReason(record, "id", "string"));
  const instrument = instrumentFields(record);
  if (!instrument) {
    const detail = instrumentFailureDetail(record);
    fail(detail.fieldName, detail.reason);
  }
  const paidOnDate = requiredString(record, "paid_on");
  if (!paidOnDate)
    fail("paid_on", requiredFailureReason(record, "paid_on", "string"));
  if (!isMarketDate(paidOnDate)) fail("paid_on", "invalid_format");
  const amountDecimal = requiredDecimal(record, "amount", {
    allowNegative: false,
  });
  if (!amountDecimal)
    fail("amount", requiredDecimalFailureReason(record, "amount"));
  // Franking/withholding figures feed downstream tax assumptions -- a
  // present-but-corrupt value must fail the item closed, never silently
  // become an honest "unknown" (BRK-003 review finding F1).
  const frankedAmountDecimal = optionalDecimal(record, "franked_amount");
  if (frankedAmountDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("franked_amount", "invalid_decimal");
  }
  const unfrankedAmountDecimal = optionalDecimal(record, "unfranked_amount");
  if (unfrankedAmountDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("unfranked_amount", "invalid_decimal");
  }
  const taxWithheldDecimal = optionalDecimal(
    record,
    "resident_withholding_tax",
  );
  if (taxWithheldDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("resident_withholding_tax", "invalid_decimal");
  }
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
