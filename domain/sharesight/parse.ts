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
  SharesightUserInstrument,
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

/** Sentinel distinguishing "field present but not a boolean" from a
 * genuinely absent/null field -- mirrors `MALFORMED_OPTIONAL_STRING`/
 * `MALFORMED_OPTIONAL_DECIMAL`'s absent-vs-malformed discipline for optional
 * BOOLEAN fields. Introduced for the live-confirmed payout fields
 * `confirmed`/`trust`/`non_taxable` (BRK-008, 2026-08-15 v2 payouts pass). */
const MALFORMED_OPTIONAL_BOOLEAN = Symbol(
  "sharesight-malformed-optional-boolean",
);

function optionalBooleanField(
  record: RecordValue,
  field: string,
): boolean | null | typeof MALFORMED_OPTIONAL_BOOLEAN {
  const value = record[field];
  if (value === undefined || value === null) {
    return null; // genuinely absent/null -- an honest "unknown"
  }
  if (typeof value !== "boolean") return MALFORMED_OPTIONAL_BOOLEAN;
  return value;
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

/** Sentinel distinguishing "field present but not a valid integer id" from a
 * genuinely absent/null field -- mirrors this module's other
 * `MALFORMED_OPTIONAL_*` sentinels. Introduced for `SharesightPayout.id`
 * (BRK-008, 2026-08-15 follow-up): live evidence (item #2/118) showed an
 * explicit `id: null` on an otherwise-complete payout item -- see
 * `SharesightPayout`'s doc comment for the (inference-labelled)
 * unconfirmed-payout interpretation. */
const MALFORMED_OPTIONAL_ID = Symbol("sharesight-malformed-optional-id");

/**
 * Like `requiredIntegerIdDecimalString`, but tolerates a missing id as an
 * honest `null` rather than failing the item closed. Used ONLY for
 * `SharesightPayout.id` (BRK-008, 2026-08-15 follow-up) -- portfolios/
 * holdings/trades ids remain REQUIRED via `requiredIntegerIdDecimalString`,
 * unchanged. An explicit `null` and a genuinely absent field are tolerated
 * IDENTICALLY as `null`: live evidence confirms the former (item #2/118),
 * but there is no evidence basis to treat an absent id any differently, so
 * this is a documented choice, not an observation. A present value that is
 * not a valid non-negative safe integer still fails the item closed (the
 * same structural checks as the required version), since that is a
 * malformed id, not an honest "unknown".
 */
function optionalIntegerIdDecimalString(
  record: RecordValue,
  field: string,
): string | null | typeof MALFORMED_OPTIONAL_ID {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") return MALFORMED_OPTIONAL_ID;
  if (!Number.isInteger(value)) return MALFORMED_OPTIONAL_ID;
  if (!Number.isSafeInteger(value)) return MALFORMED_OPTIONAL_ID;
  if (value < 0) return MALFORMED_OPTIONAL_ID;
  return String(value);
}

/**
 * BRK-012B: validates `current_price_updated_at`'s shape WITHOUT converting
 * it -- an ISO-8601 date-time carrying an explicit offset (`Z` or a numeric
 * `+HH:MM`/`-HH:MM`), matching every observed live value
 * (`docs/ARCHITECTURE.md` §8.2's BRK-012A entry, e.g. `+10:00` for Sydney).
 * `Date.parse` is used only as a sanity check that the value is a real
 * instant (rejects e.g. `2026-13-40T99:99:99+10:00`); the STRING itself,
 * offset intact, is what `SharesightUserInstrument.currentPriceUpdatedAt`
 * retains and what `price-accretion.ts` derives a trading date from -- never
 * `new Date(value).toISOString()`, which would silently re-express the
 * instant in UTC and could shift a late-evening positive-offset observation
 * onto the wrong calendar day.
 */
function isTimestampWithOffset(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
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

/**
 * BRK-017 step 2 (docs/ARCHITECTURE.md §8.2, live probe recorded
 * 2026-09-04): none of the Sharesight list endpoints `parseItemList` serves
 * (portfolios/holdings/trades/payouts/user_instruments) paginates
 * server-side TODAY -- every probed response carried only a `links.self`
 * echo (or an empty `links: {}`), and `page`/`per_page` never changed the
 * returned array's length. That is observed BEHAVIOUR, not a documented
 * contract, so a future Sharesight change that starts truncating these
 * lists must never be swallowed as a silent partial import. This guard
 * inspects the envelope for pagination-shaped metadata that indicates more
 * data exists than the array already returned, and fails the WHOLE list
 * closed (`invalid_response`, never a partial list) the instant it sees
 * one.
 *
 * Deliberately narrow: only the exact key names/value shapes below trip
 * it. `links.self` alone, an empty `links: {}`, and any other sibling key
 * (e.g. the real `api_transaction` sibling observed on the trades
 * envelope) must pass unchanged -- this is not a general "reject unknown
 * keys" trip-wire, only a "the provider just told us there's more" one.
 * Checked against the top-level envelope AND a `meta`/`pagination`
 * sub-object, since different APIs nest paging metadata differently; none
 * of that nesting has ever been observed live, so this is deliberately
 * conservative for a shape that hasn't happened yet.
 *
 * Returns the offending key name (never a value) for the error message, or
 * `null` if nothing pagination-shaped was found.
 */
function findPaginationEvidence(
  record: RecordValue,
  arrayLength: number,
): string | null {
  const links = asRecord(record.links);
  if (links) {
    if (typeof links.next === "string" && links.next.length > 0) {
      return "links.next";
    }
    if (typeof links.prev === "string" && links.prev.length > 0) {
      return "links.prev";
    }
  }

  const containers: RecordValue[] = [record];
  const meta = asRecord(record.meta);
  if (meta) containers.push(meta);
  const pagination = asRecord(record.pagination);
  if (pagination) containers.push(pagination);

  for (const container of containers) {
    if (
      typeof container.total_pages === "number" &&
      container.total_pages > 1
    ) {
      return "total_pages";
    }
    if (typeof container.page_count === "number" && container.page_count > 1) {
      return "page_count";
    }
    if (container.next_page !== undefined && container.next_page !== null) {
      return "next_page";
    }
    if (
      typeof container.total_count === "number" &&
      container.total_count > arrayLength
    ) {
      return "total_count";
    }
    if (typeof container.total === "number" && container.total > arrayLength) {
      return "total";
    }
    // `per_page` alone doesn't say how many items exist in total, but a
    // returned page filled all the way to that declared cap is exactly the
    // ambiguous case this guard exists for -- we cannot tell whether that's
    // a coincidence or a truncation, so treat it as evidence of more.
    if (
      typeof container.per_page === "number" &&
      container.per_page > 0 &&
      arrayLength >= container.per_page
    ) {
      return "per_page";
    }
  }
  return null;
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
  const paginationKey = findPaginationEvidence(
    record as RecordValue,
    rawList.length,
  );
  if (paginationKey) {
    return invalid(
      `Sharesight ${itemLabel} response carries pagination metadata ` +
        `("${paginationKey}") indicating more data exists than the ` +
        `${rawList.length}-item list returned; refusing to return a ` +
        `possibly-truncated list.`,
    );
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
 * exchange/MIC + currency), so a holding/trade item missing any of them
 * fails closed rather than resolving against an incomplete key. Validated
 * shallowly -- only these three fields are read; every other key on the
 * live `instrument` object (`country_id`, `crypto`, `expired`, `logo`,
 * `classifications`, etc.) is ignored, not validated or retained.
 *
 * NOT used by `parsePayoutItem` -- BRK-008's 2026-08-15 v2 payouts pass
 * live-confirmed payout items carry FLAT top-level `symbol`/`market`/
 * `currency` fields instead of a nested `instrument` object (see
 * `SharesightPayout`'s doc comment).
 */
function instrumentFields(record: RecordValue): {
  instrumentCode: string;
  marketCode: string;
  currencyCode: string;
  /** The raw, already-validated-present `instrument` sub-object, threaded
   * through to `instrumentMetadataFields` so it doesn't have to re-derive
   * `asRecord(record.instrument)` itself (BRK-009A). */
  raw: RecordValue;
} | null {
  const instrument = asRecord(record.instrument);
  if (!instrument) return null;
  const instrumentCode = requiredString(instrument, "code");
  const marketCode = requiredString(instrument, "market_code");
  const currencyCode = requiredString(instrument, "currency_code");
  if (!instrumentCode || !marketCode || !currencyCode) return null;
  return { instrumentCode, marketCode, currencyCode, raw: instrument };
}

/**
 * F1 (2026-08-18 reviewer ruling, `docs/ARCHITECTURE.md` §8.2's BRK-009A
 * addendum): a DELIBERATE DEVIATION from this module's otherwise-universal
 * fail-closed discipline for optional fields. `instrument.id`/payouts'
 * `instrument_id` are Sharesight's own record id for the instrument -- an
 * AUXILIARY MATCHING AID `domain/securities/resolve-security.ts`'s
 * `sharesight_instrument` tier can use, not financial data -- and their
 * presence/shape on the wire is UNCONFIRMED (an inference, not an
 * observation; see the §8.2 note). Unlike a corrupt franking figure or
 * price, a malformed value here must never be able to fail a whole live
 * sync closed: it simply degrades that instrument to ticker-tier
 * resolution instead. Accepts a numeric integer (the same
 * `requiredIntegerIdDecimalString`/`optionalIntegerIdDecimalString`
 * technique every other id field uses) OR an integer-SHAPED string
 * (trimmed, digits-only, safe-integer range) -- both normalize to the SAME
 * canonical decimal string, tolerating either wire shape since neither is
 * confirmed. Any OTHER present value (boolean, object, array, float,
 * non-digit string, negative/unsafe integer) resolves to `null` -- never a
 * thrown failure, unlike `MALFORMED_OPTIONAL_ID`'s ordinary fail-closed
 * sibling `optionalIntegerIdDecimalString` above (still used, unchanged,
 * for genuinely financial/identity-critical ids like `SharesightPayout.id`
 * itself).
 */
function optionalAuxiliaryInstrumentId(
  record: RecordValue,
  field: string,
): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    if (!Number.isSafeInteger(value)) return null;
    if (value < 0) return null;
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric)) return null;
    return String(numeric);
  }
  return null; // boolean, object, array, etc. -- degrade, never fail
}

/**
 * BRK-009A (2026-08-18): reads the OPTIONAL, absent-tolerant instrument
 * metadata keys (`id`, `name`, `isin`) off an already-validated `instrument`
 * sub-object -- the REQUIRED `code`/`market_code`/`currency_code` keys are
 * validated separately by `instrumentFields` above and are never touched
 * here. UNCONFIRMED presence: the BRK-008 live pass that confirmed the three
 * required keys never confirmed whether `id`/`name`/`isin` are present on
 * the real wire shape (per `docs/ARCHITECTURE.md` §8.2 and TASKS.md's
 * BRK-009A ruling). `name`/`isin` follow this module's established
 * absent-vs-malformed discipline exactly: absent/null is an honest `null`;
 * present-but-wrong-type fails the WHOLE ITEM closed. `id` is the ONE
 * exception -- see `optionalAuxiliaryInstrumentId`'s doc comment (F1): a
 * malformed value degrades to `null` rather than failing the item. Never
 * invented when absent, never required.
 */
function instrumentMetadataFields(instrument: RecordValue): {
  sharesightInstrumentId: string | null;
  instrumentName: string | null;
  isin: string | null;
} {
  const sharesightInstrumentId = optionalAuxiliaryInstrumentId(
    instrument,
    "id",
  );
  const instrumentName = optionalStringField(instrument, "name");
  if (instrumentName === MALFORMED_OPTIONAL_STRING) {
    fail("instrument.name", "wrong_type");
  }
  const isin = optionalStringField(instrument, "isin");
  if (isin === MALFORMED_OPTIONAL_STRING) {
    fail("instrument.isin", "wrong_type");
  }
  return { sharesightInstrumentId, instrumentName, isin };
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
  // BRK-009A: OPTIONAL, absent-tolerant instrument metadata -- see
  // `instrumentMetadataFields`'s doc comment.
  const metadata = instrumentMetadataFields(instrument.raw);
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
    sharesightInstrumentId: metadata.sharesightInstrumentId,
    instrumentName: metadata.instrumentName,
    isin: metadata.isin,
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
  // BRK-009A: OPTIONAL, absent-tolerant instrument metadata -- see
  // `instrumentMetadataFields`'s doc comment.
  const instrumentMetadata = instrumentMetadataFields(instrument.raw);
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
    sharesightInstrumentId: instrumentMetadata.sharesightInstrumentId,
    instrumentName: instrumentMetadata.instrumentName,
    isin: instrumentMetadata.isin,
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

/**
 * Live-confirmed 2026-08-15 (v2 payouts route, 118 items -- see
 * `docs/ARCHITECTURE.md` §8.2 and `SharesightPayout`'s doc comment). Unlike
 * holdings/trades, payout items carry FLAT top-level `symbol`/`market`/
 * `currency` fields, not a nested `instrument` object -- `instrumentFields`
 * does not apply here.
 */
function parsePayoutItem(item: unknown, portfolioId: string): SharesightPayout {
  const record = asRecord(item);
  if (!record) fail("<item>", "wrong_type");

  // `holding_id`/`portfolio_id` are numeric on the wire and REQUIRED -- the
  // same technique portfolios/holdings/trades already use. `id` is the same
  // numeric-on-the-wire technique but NOT required: live evidence (item
  // #2/118, BRK-008 2026-08-15 follow-up) showed an explicit `id: null` on
  // an otherwise-complete payout item, so it is tolerated as `null` --
  // see `SharesightPayout.id`'s doc comment and
  // `optionalIntegerIdDecimalString` above for the absent-vs-null choice.
  const id = optionalIntegerIdDecimalString(record, "id");
  if (id === MALFORMED_OPTIONAL_ID) fail("id", "wrong_type");
  // BRK-009A (2026-08-18): `instrument_id` is LIVE-CONFIRMED present on the
  // 118-item payout fixture but was previously ignored -- now captured
  // OPTIONALLY so a payout's instrument can resolve via the
  // `sharesight_instrument` identifier tier too. See `SharesightPayout`'s
  // doc comment. F1 (2026-08-18 reviewer ruling): unlike `id` immediately
  // above, this is an auxiliary matching aid, not financial data -- a
  // malformed value degrades to `null` rather than failing the item closed
  // (see `optionalAuxiliaryInstrumentId`'s doc comment).
  const sharesightInstrumentId = optionalAuxiliaryInstrumentId(
    record,
    "instrument_id",
  );
  const holdingId = requiredIntegerIdDecimalString(record, "holding_id");
  if (!holdingId) {
    fail("holding_id", requiredFailureReason(record, "holding_id", "number"));
  }
  // Real cross-check, not a reworded no-op -- mirrors `parseTradeItem`'s own
  // `portfolio_id` check: the payout item's OWN `portfolio_id` must be
  // present, well-shaped, AND EQUAL to the caller-supplied `portfolioId`
  // this fetch was scoped to. A mismatch fails the item closed rather than
  // silently re-attributing a mis-scoped record to the queried portfolio.
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

  // FLAT top-level fields -- see this function's doc comment.
  const symbol = requiredString(record, "symbol");
  if (!symbol)
    fail("symbol", requiredFailureReason(record, "symbol", "string"));
  const marketCode = requiredString(record, "market");
  if (!marketCode)
    fail("market", requiredFailureReason(record, "market", "string"));
  const currencyCodeRaw = requiredString(record, "currency");
  if (!currencyCodeRaw) {
    fail("currency", requiredFailureReason(record, "currency", "string"));
  }
  if (!isCurrencyCode(currencyCodeRaw)) fail("currency", "invalid_format");
  const currencyCode = currencyCodeRaw;

  const paidOnDate = requiredString(record, "paid_on");
  if (!paidOnDate)
    fail("paid_on", requiredFailureReason(record, "paid_on", "string"));
  if (!isMarketDate(paidOnDate)) fail("paid_on", "invalid_format");

  // Unsigned -- no live payout item was observed carrying a negative
  // amount, unlike trades' `value` (item #46/107, LIVE-CONFIRMED signed).
  // Sign tolerance here is a future call, not assumed without evidence --
  // see `SharesightPayout`'s doc comment.
  const amountDecimal = requiredDecimal(record, "amount", {
    allowNegative: false,
  });
  if (!amountDecimal)
    fail("amount", requiredDecimalFailureReason(record, "amount"));
  const grossAmountDecimal = requiredDecimal(record, "gross_amount", {
    allowNegative: false,
  });
  if (!grossAmountDecimal) {
    fail("gross_amount", requiredDecimalFailureReason(record, "gross_amount"));
  }

  // Franking/withholding figures feed downstream tax assumptions -- a
  // present-but-corrupt value must fail the item closed, never silently
  // become an honest "unknown" (BRK-003 review finding F1). `franking_credits`
  // is new in this live pass -- see `SharesightPayout`'s doc comment on why
  // this closes the MKT-005 franking-unavailable seam as a future DIV-001
  // decision.
  const frankedAmountDecimal = optionalDecimal(record, "franked_amount");
  if (frankedAmountDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("franked_amount", "invalid_decimal");
  }
  const unfrankedAmountDecimal = optionalDecimal(record, "unfranked_amount");
  if (unfrankedAmountDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("unfranked_amount", "invalid_decimal");
  }
  const frankingCreditsDecimal = optionalDecimal(record, "franking_credits");
  if (frankingCreditsDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("franking_credits", "invalid_decimal");
  }
  const residentWithholdingTaxDecimal = optionalDecimal(
    record,
    "resident_withholding_tax",
  );
  if (residentWithholdingTaxDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("resident_withholding_tax", "invalid_decimal");
  }
  const nonResidentWithholdingTaxDecimal = optionalDecimal(
    record,
    "non_resident_withholding_tax",
  );
  if (nonResidentWithholdingTaxDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("non_resident_withholding_tax", "invalid_decimal");
  }
  const exchangeRateDecimal = optionalDecimal(record, "exchange_rate");
  if (exchangeRateDecimal === MALFORMED_OPTIONAL_DECIMAL) {
    fail("exchange_rate", "invalid_decimal");
  }

  const goesExOnDate = optionalStringField(record, "goes_ex_on");
  if (goesExOnDate === MALFORMED_OPTIONAL_STRING) {
    fail("goes_ex_on", "wrong_type");
  }
  const state = optionalStringField(record, "state");
  if (state === MALFORMED_OPTIONAL_STRING) fail("state", "wrong_type");
  const comments = optionalStringField(record, "comments");
  if (comments === MALFORMED_OPTIONAL_STRING) fail("comments", "wrong_type");

  const confirmed = optionalBooleanField(record, "confirmed");
  if (confirmed === MALFORMED_OPTIONAL_BOOLEAN) {
    fail("confirmed", "wrong_type");
  }
  const trust = optionalBooleanField(record, "trust");
  if (trust === MALFORMED_OPTIONAL_BOOLEAN) fail("trust", "wrong_type");
  const nonTaxable = optionalBooleanField(record, "non_taxable");
  if (nonTaxable === MALFORMED_OPTIONAL_BOOLEAN) {
    fail("non_taxable", "wrong_type");
  }

  return {
    id,
    portfolioId,
    holdingId,
    sharesightInstrumentId,
    symbol,
    marketCode,
    currencyCode,
    paidOnDate,
    amountDecimal,
    grossAmountDecimal,
    frankedAmountDecimal,
    unfrankedAmountDecimal,
    frankingCreditsDecimal,
    residentWithholdingTaxDecimal,
    nonResidentWithholdingTaxDecimal,
    goesExOnDate,
    state,
    confirmed,
    trust,
    nonTaxable,
    comments,
    exchangeRateDecimal,
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

/**
 * BRK-012B: parses `user_instruments.json`'s `instruments` list into typed
 * `SharesightUserInstrument`s. EVERY returned item is validated (not just
 * the 8/18 BRK-012A directly sampled) -- an item missing/malformed on any of
 * the five required fields fails THAT item closed via `itemFailure`, per
 * this module's universal per-item discipline (`parseItemList`).
 */
function parseUserInstrumentItem(item: unknown): SharesightUserInstrument {
  const record = asRecord(item);
  if (!record) fail("<item>", "wrong_type");
  // Same numeric-id technique portfolios/holdings/trades already use.
  const id = requiredIntegerIdDecimalString(record, "id");
  if (!id) fail("id", requiredFailureReason(record, "id", "number"));
  const code = requiredString(record, "code");
  if (!code) fail("code", requiredFailureReason(record, "code", "string"));
  const marketCode = requiredString(record, "market_code");
  if (!marketCode) {
    fail("market_code", requiredFailureReason(record, "market_code", "string"));
  }
  const currencyCodeRaw = requiredString(record, "currency_code");
  if (!currencyCodeRaw) {
    fail(
      "currency_code",
      requiredFailureReason(record, "currency_code", "string"),
    );
  }
  if (!isCurrencyCode(currencyCodeRaw)) fail("currency_code", "invalid_format");
  const currencyCode = currencyCodeRaw;
  const currentPriceDecimal = requiredDecimal(record, "current_price");
  if (!currentPriceDecimal) {
    fail(
      "current_price",
      requiredDecimalFailureReason(record, "current_price"),
    );
  }
  const currentPriceUpdatedAt = requiredString(
    record,
    "current_price_updated_at",
  );
  if (!currentPriceUpdatedAt) {
    fail(
      "current_price_updated_at",
      requiredFailureReason(record, "current_price_updated_at", "string"),
    );
  }
  if (!isTimestampWithOffset(currentPriceUpdatedAt)) {
    fail("current_price_updated_at", "invalid_format");
  }

  return {
    id,
    code,
    marketCode,
    currencyCode,
    currentPriceDecimal,
    currentPriceUpdatedAt,
  };
}

export function parseSharesightUserInstruments(
  root: unknown,
): SharesightResult<SharesightUserInstrument[]> {
  return parseItemList(
    root,
    "instruments",
    parseUserInstrumentItem,
    "user instruments",
  );
}
