// BRK-003: contract types for the Sharesight GET-only client foundation.
//
// Sharesight is a read-only external system of record holding the owner's
// tax data (AGENTS.md non-negotiable). Its User API v3 is read-write with no
// granular OAuth scopes, so read-only must be enforced at the application
// layer: every type/function in `domain/sharesight/` models GET-only data
// access, plus the one documented exception (OAuth client-credentials token
// acquisition, isolated in `token.ts`). Nothing here performs an app -> data
// write against Sharesight, and nothing here is a quote provider (BRK-002
// decision) -- see `docs/MARKET_DATA_STRATEGY.md` for why this module is
// intentionally out of scope there.

export type SharesightErrorKind =
  | "authentication"
  | "entitlement"
  | "rate_limit"
  | "invalid_response"
  | "timeout"
  | "transient_upstream"
  | "non_get_rejected";

/**
 * BRK-008 live-spike diagnostic: the closed allowlist of RFC 6749 §5.2
 * TOKEN-endpoint `error` values that `token.ts` will ever surface as
 * `SharesightError.oauthErrorCode`. Any other string (a provider-specific
 * extension code, a typo, anything not in this list) is discarded unread by
 * `token.ts` rather than surfaced -- see that module's `readOAuthErrorCode`
 * for why an open-ended value is never trusted onto a typed result.
 */
export const SHARESIGHT_OAUTH_ERROR_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
] as const;

export type SharesightOAuthErrorCode =
  (typeof SHARESIGHT_OAUTH_ERROR_CODES)[number];

/**
 * BRK-008 diagnostic (2026-08-15 follow-up): the closed set of reasons a
 * single Sharesight response-list ITEM can fail `parse.ts` validation --
 * classified by FORMAT CLASS only, never by the field's actual value:
 *   - `missing`: the field is absent/null/empty where a value is required
 *     (an honest "unknown", not malformed);
 *   - `wrong_type`: the field is present but not the expected JSON type
 *     (e.g. a number where a string was required), or a correctly-typed
 *     value that fails a structural check with no clearer bucket (e.g. a
 *     non-integer/negative/unsafe id number);
 *   - `invalid_decimal`: the field is present but does not parse as a
 *     decimal string (`parse.ts`'s `decimalString`) -- covers a malformed
 *     money/quantity field;
 *   - `invalid_format`: the field is a correctly-typed string that fails a
 *     further shape check (a non-ISO-8601 date, a currency code that isn't
 *     3 uppercase letters, a `transaction_type` outside the modelled enum);
 *   - `mismatch`: the field is present and well-shaped but fails a
 *     cross-check against caller-supplied context (e.g. a trade's own
 *     `portfolio_id` disagreeing with the portfolio this fetch was scoped
 *     to).
 */
export type SharesightItemFailureReason =
  "missing" | "wrong_type" | "invalid_decimal" | "invalid_format" | "mismatch";

/**
 * BRK-008 diagnostic (2026-08-15 follow-up): identifies WHICH item in a
 * response list failed `parse.ts` validation and WHICH field, WITHOUT ever
 * carrying the field's value. `itemIndex` is the item's position in the raw
 * response array (0-based); `fieldName` is a static field NAME (Sharesight's
 * own wire name, e.g. `"transaction_date"`, or a dotted nested path like
 * `"instrument.code"` -- never a value, never caller-supplied data); `reason`
 * is the closed `SharesightItemFailureReason` classification above. Safe for
 * general consumption (logs, error displays) on the same no-values footing
 * as `kind`/`message` -- unlike the FULL item shape (`SharesightItemFailureEvidence.itemShape`
 * on the client's opt-in `onItemFailureEvidence` diagnostic), which stays
 * behind that separate, explicitly-opted-into callback.
 */
export type SharesightItemFailureDetail = Readonly<{
  itemIndex: number;
  fieldName: string;
  reason: SharesightItemFailureReason;
}>;

export type SharesightError = Readonly<{
  kind: SharesightErrorKind;
  message: string;
  retryable: boolean;
  /**
   * BRK-008 diagnostic only: the TOKEN endpoint's OAuth `error` code
   * (RFC 6749 §5.2), present only when `token.ts` received a non-2xx
   * response from the token endpoint whose body parsed as JSON with an
   * `error` field matching `SHARESIGHT_OAUTH_ERROR_CODES` exactly. Never set
   * by the data client (`client.ts`) -- that module never reads a non-2xx
   * body at all. Distinguishes e.g. `invalid_client` (bad client id/secret)
   * from `invalid_grant` (bad/expired code, redirect mismatch) without
   * surfacing anything else from the body -- see `token.ts`'s
   * `readOAuthErrorCode` for the bounded, defensive read that produces this.
   */
  oauthErrorCode?: SharesightOAuthErrorCode;
  /**
   * BRK-008 diagnostic only (2026-08-15 follow-up): present only when `kind`
   * is `"invalid_response"` AND the failure was traced to one specific item
   * in a response LIST (`parse.ts`'s `parseItemList`) -- never set for an
   * envelope-level failure (e.g. the list key itself is missing/not an
   * array), since there is no single item to attribute it to. Names/enums
   * only -- see `SharesightItemFailureDetail`'s doc comment for the
   * no-values discipline.
   */
  itemFailure?: SharesightItemFailureDetail;
}>;

export type SharesightResult<T> =
  { ok: true; value: T } | { ok: false; error: SharesightError };

/**
 * Fetch evidence recorded alongside a successful GET: a hash of the raw
 * response body (per the MKT-002 evidence convention -- `payloadSha256` on
 * `PriceObservation`/`FxObservation`) and the ingestion timestamp. The raw
 * body itself is never retained here; only the hash and metadata are, so a
 * caller that logs/stores this evidence can never leak a payload dump.
 */
export type SharesightFetchEvidence = Readonly<{
  payloadSha256: string;
  ingestedAt: string;
}>;

/**
 * BRK-008 diagnostic: metadata-only evidence for the failure class where
 * `getJson` reads a response body but `JSON.parse` itself throws (e.g. an
 * endpoint that silently returns an HTML page instead of JSON -- the
 * observed 2026-08-15 `listPayouts` symptom before its endpoint path was
 * corrected). This is a DIFFERENT failure class from a parsed-but-invalid
 * domain shape (`SharesightFetchEvidence`'s sibling `onShapeEvidence`
 * diagnostic covers that one) -- there is no parsed JSON to derive a field
 * shape from here, only transport-level metadata. Never the body itself,
 * never a byte of its content: only content-type, HTTP status, the fixed
 * `bodyParseable: false` marker, and a byte count.
 */
export type SharesightBodyParseDiagnostic = Readonly<{
  contentType: string | null;
  httpStatus: number;
  bodyParseable: false;
  /**
   * Counts differently depending on which of the two failure classes above
   * fired this diagnostic: on the `JSON.parse`-throw branch (a 2xx response
   * whose body was fully read before parsing failed), this is the FULL
   * body's exact byte length; on the non-2xx branch (2026-08-15 follow-up),
   * this is capped at 4,096 bytes read via a bounded reader (see
   * `client.ts`'s `readBoundedBodyByteCountForDiagnostic`) — a non-2xx body
   * larger than that cap reports exactly `4096`, not its true size, and a
   * stalled/unreadable non-2xx body reports `0`. Best-effort and
   * diagnostic-only in both cases; never load-bearing for the typed error
   * result it accompanies.
   */
  bodyBytes: number;
  /**
   * BRK-008 diagnostic (2026-08-15 follow-up, payouts wiring fix):
   * `Response.redirected` -- true when the underlying fetch followed one or
   * more redirects before landing on the response this diagnostic describes
   * (e.g. a data request whose URL 302's to an HTML login/error page, which
   * is exactly the observed 2026-08-15 `listPayouts` failure mode this field
   * exists to make visible next time). `client.ts` never sets
   * `RequestInit.redirect` itself, so the underlying fetch follows redirects
   * by its platform default; this field reports whether that happened, it
   * does not change the behavior. A test harness that hand-constructs a
   * `Response` (rather than a real fetch response) reports `false` here --
   * absence of evidence, not evidence of absence -- but this field never
   * fabricates `true`.
   */
  redirected: boolean;
}>;

/**
 * BRK-008 diagnostic (2026-08-15 follow-up): the client's opt-in
 * `onItemFailureEvidence` payload -- `SharesightItemFailureDetail`'s
 * names/enums (`itemIndex`/`fieldName`/`reason`) PLUS the FAILING item's
 * full derived shape (`deriveShapeEvidence` -- key names, `typeof` leaves,
 * format-class annotations only; see `shape-evidence.ts`'s privacy
 * contract). `itemShape` is deliberately NOT part of `SharesightError`
 * itself (which flows to ordinary application error handling/logging) --
 * it stays behind this separate, explicitly-opted-into diagnostic callback,
 * the same separation `onShapeEvidence` already draws for the whole-payload
 * shape.
 */
export type SharesightItemFailureEvidence = Readonly<{
  itemIndex: number;
  fieldName: string;
  reason: SharesightItemFailureReason;
  itemShape: unknown;
}>;

// --- v3 endpoint shapes (BRK-008 spike scope) -------------------------
//
// Money/quantity fields are decimal STRINGS (AGENTS.md non-negotiable),
// parsed defensively from whatever JSON shape (number or string) the
// provider returns -- see `parse.ts`. These are deliberately minimal: only
// the fields the BRK-008 spike needs. Extend when a real spike/response
// shows a field is actually required, not speculatively.

/**
 * Live-confirmed shape (2026-08-15, owner's real account -- see
 * `docs/ARCHITECTURE.md` §8.2): the `portfolios` list envelope item.
 * `id`/`name`/`currency_code` are REQUIRED; `id` is a numeric integer,
 * normalized to a decimal STRING by `parse.ts`'s
 * `requiredIntegerIdDecimalString` (AGENTS.md decimal-string discipline).
 * The remaining fields are OPTIONAL (present-but-null and genuinely-absent
 * both parse as `null`; a present-but-wrong-type value fails the whole item
 * closed -- see `parse.ts`'s `optionalStringField`). `cgDiscount` is
 * deliberately an OPAQUE string: this contract never interprets it as a
 * number or percentage. Fields the live response carries but this contract
 * does not model (e.g. `consolidated`, `trader`, `user_id`) are ignored for
 * forward-compatibility, not validated or retained.
 */
export type SharesightPortfolio = Readonly<{
  id: string;
  name: string;
  currencyCode: string;
  inceptionDate: string | null;
  tzName: string | null;
  accessLevel: string | null;
  financialYearEnd: string | null;
  cgDiscount: string | null;
  countryCode: string | null;
  ownerName: string | null;
  taxEntityType: string | null;
}>;

/**
 * Live-confirmed shape (2026-08-15, owner's real account -- see
 * `docs/ARCHITECTURE.md` §8.2): `id`, `symbol`, and the instrument
 * resolution keys (`instrument.code`/`instrument.market_code`/
 * `instrument.currency_code`) are REQUIRED. `quantityDecimal` is OPTIONAL
 * (`string | null`), NOT required as BRK-003 originally assumed -- the
 * confirmed v3 `HoldingPortfolioList` response carries no quantity/value
 * field at all on this endpoint; `averageCostDecimal`/`marketValueDecimal`
 * remain optional for the same reason, kept in case a different
 * params/endpoint combination ever returns them.
 */
export type SharesightHolding = Readonly<{
  id: string;
  portfolioId: string;
  symbol: string;
  instrumentCode: string;
  marketCode: string;
  currencyCode: string;
  quantityDecimal: string | null;
  averageCostDecimal: string | null;
  marketValueDecimal: string | null;
}>;

export type SharesightTradeType = "buy" | "sell" | "other";

/**
 * Live-confirmed shape (2026-08-15, owner's real account -- see
 * `docs/ARCHITECTURE.md` §8.2). REQUIRED: `id` (numeric, like
 * portfolios/holdings), `transactionDate`, `quantityDecimal`,
 * `priceDecimal`, `holdingId`, and the instrument resolution keys. The
 * trade item's OWN `portfolio_id` field is validated for presence, shape,
 * AND equality against the caller-supplied `portfolioId` this fetch was
 * scoped to -- a mismatch fails the whole item closed (never silently
 * re-attributed to the queried portfolio), so `portfolioId` here is always
 * both the trusted context AND independently confirmed by the record
 * itself. `valueDecimal` is nullable-tolerant (evidence shows
 * other trade fields can be null; treated the same as an optional decimal
 * rather than failing the whole item closed on a null `value`).
 * `transactionType` is OPTIONAL -- the live response's first item did not
 * carry this field at all, so an absent value is an honest `null`, not a
 * parse failure; a PRESENT value outside the modelled `buy`/`sell`/`other`
 * enum still fails the item closed (absent-vs-malformed discipline, BRK-003
 * review finding F1). The remaining fields are optional per evidence.
 *
 * BRK-008 live evidence (2026-08-15, item #46/107): that item's
 * `itemFailure` diagnostic reported `fieldName: "value"`, and `quantity` is
 * parsed BEFORE `value` in `parse.ts`'s `parseTradeItem` -- so item #46's
 * `quantity` MUST have already passed the (then-unsigned-only) parse to
 * reach the `value` check at all. That LIVE-CONFIRMS Sharesight SIGNS
 * `valueDecimal` to carry trade direction (a sell is negative); it is NOT
 * evidence that `quantityDecimal` is ever negative. `quantityDecimal` also
 * accepts a leading `-` as an INFERENCE extrapolated from `valueDecimal`'s
 * confirmed signedness (kept fail-open so a genuinely signed live quantity
 * doesn't re-block the whole list), but remains UNCONFIRMED pending a live
 * item that actually exercises a negative `quantity`. This means the
 * `docs/ARCHITECTURE.md` §8.2 "no recoverable direction" note is RESTATED,
 * not superseded: the CONFIRMED direction signal is `valueDecimal`'s sign;
 * `quantityDecimal`'s sign is pending confirmation. `priceDecimal`/
 * `brokerageDecimal` remain unsigned (a per-unit price or fee magnitude, not
 * a direction carrier) unless future evidence says otherwise. `comments` is
 * a new OPTIONAL string field (present as a string on some items, `null` on
 * others) -- null-tolerant per the optional-field sentinel discipline.
 */
export type SharesightTrade = Readonly<{
  id: string;
  portfolioId: string;
  holdingId: string;
  instrumentCode: string;
  marketCode: string;
  transactionType: SharesightTradeType | null;
  transactionDate: string;
  currencyCode: string;
  /** Signed decimal string -- accepts a leading `-`. UNCONFIRMED live: this
   * is an inference extrapolated from `valueDecimal`'s confirmed signedness
   * (BRK-008 2026-08-15, item #46/107), not itself observed negative on a
   * live item. */
  quantityDecimal: string;
  /** Unsigned decimal string -- a per-unit price magnitude, never signed. */
  priceDecimal: string;
  /** Signed decimal string when present -- negative for a sell.
   * LIVE-CONFIRMED (BRK-008 2026-08-15, item #46/107). */
  valueDecimal: string | null;
  brokerageDecimal: string | null;
  brokerageCurrencyCode: string | null;
  exchangeRateDecimal: string | null;
  exchangeRatePair: string | null;
  state: string | null;
  uniqueIdentifier: string | null;
  paidOnDate: string | null;
  descriptionCode: string | null;
  sourceCategory: string | null;
  comments: string | null;
}>;

/**
 * Live-confirmed shape (2026-08-15, owner's real account, v2 payouts route,
 * 118 items -- see `docs/ARCHITECTURE.md` §8.2). REQUIRED: `id`, `holdingId`,
 * `portfolioId` (all numeric on the wire, normalized to decimal strings via
 * `requiredIntegerIdDecimalString`, the same technique portfolios/holdings/
 * trades already use); `paidOnDate`; `symbol`/`marketCode`/`currencyCode`
 * (FLAT top-level `symbol`/`market`/`currency` fields -- NOT a nested
 * `instrument` object like holdings/trades. This was an open, unconfirmed
 * follow-up as of the previous §8.2 entry, resting only on a third-party
 * client's documented example; it is now directly, live-confirmed observed);
 * and `amountDecimal`/`grossAmountDecimal`. The item's own `portfolio_id` is
 * validated for presence, shape, AND equality against the caller-supplied
 * `portfolioId` this fetch was scoped to -- a mismatch fails the item closed,
 * the same cross-check `parseTradeItem` performs (never silently
 * re-attributing a mis-scoped record to the queried portfolio).
 *
 * `amountDecimal`/`grossAmountDecimal` are parsed UNSIGNED
 * (`allowNegative: false`) -- no live payout item was observed carrying a
 * negative amount; unlike trades' `valueDecimal` (item #46/107,
 * LIVE-CONFIRMED signed), there is no equivalent evidence here that a payout
 * can be negative (e.g. a reversal/correction). Treat this as an open
 * question, not a closed one: if a future live pass surfaces a negative
 * payout amount, this must be revisited the same way trades' `value` was,
 * not silently loosened without evidence.
 *
 * OPTIONAL, present-vs-absent-vs-malformed per this module's established
 * discipline (present-but-null and genuinely-absent both parse as `null`;
 * present-but-wrong-type/unparseable fails the item closed):
 * `frankedAmountDecimal`, `unfrankedAmountDecimal`, `frankingCreditsDecimal`,
 * `residentWithholdingTaxDecimal`, `nonResidentWithholdingTaxDecimal`
 * (decimals -- tax-relevant, so a present-but-corrupt value must never
 * silently collapse to "unknown"); `goesExOnDate`, `state`, `comments`
 * (strings); `confirmed`, `trust`, `nonTaxable` (booleans, via the new
 * `optionalBooleanField`); `exchangeRateDecimal` (decimal, unsigned).
 *
 * `frankingCreditsDecimal` is the significant new field this live pass
 * surfaces: Sharesight payouts carry REAL per-payout franking credits --
 * `docs/MARKET_DATA_STRATEGY.md`'s "franking is never populated" seam
 * (MKT-005: `dividend_events.franking_percent_decimal`/
 * `franking_credit_per_share_decimal` are always written `null`, since no
 * current quote provider supplies franking data) names exactly the kind of
 * source that could close that gap -- a `DIV-001` receipts-ingestion
 * decision, not made here, but the data is now confirmed available.
 *
 * IGNORED, forward-compatibility (present on the live item, deliberately not
 * modelled or validated here): `instrument_id`, `company_event_id`, `links`
 * (envelope/item navigation, not domain data), and the tax-component fields
 * `interest_payment`, `deferred_income`, `foreign_source_income`,
 * `other_net_fsi`, `cgt_concession_amount`, `discounted_capital_gains`,
 * `non_discounted_capital_gains`, `lic_capital_gain`, `amit_increase_amount`,
 * `amit_decrease_amount` -- available on the wire but out of scope for this
 * contract; a future `BRK-005`/`DIV` integration that needs full tax-return
 * fidelity (interest income, foreign-source income, CGT concessions, AMIT
 * cost-base adjustments) will need to model these explicitly, not assume
 * they were silently captured here.
 */
export type SharesightPayout = Readonly<{
  /**
   * `string | null`. Live evidence (BRK-008, 2026-08-15 follow-up, item
   * #2/118 of the same 118-item pass this contract's doc comment above
   * describes) showed an explicit `id: null` on an otherwise-complete
   * payout item (every franking/withholding field decimal-shaped,
   * `paid_on`/`goes_ex_on`/`state`/`confirmed` all present). INFERENCE, not
   * directly observed: Sharesight likely lists an announced/unconfirmed
   * payout with a null id until it is confirmed -- its analogue of this
   * codebase's declared-not-paid concept; `confirmed`/`state` likely
   * discriminate this case, but that is not confirmed here. `parse.ts`'s
   * `optionalIntegerIdDecimalString` tolerates both an explicit `null` and a
   * genuinely absent `id` identically as `null` -- there is no live evidence
   * distinguishing the two for this field, so this is a documented choice,
   * not an observation. A null-id payout's identity for downstream
   * dedupe/upsert purposes (e.g. falling back to `(symbol, paidOnDate,
   * state)`) is a `BRK-005`/`DIV` wiring decision, explicitly NOT made here.
   */
  id: string | null;
  portfolioId: string;
  holdingId: string;
  symbol: string;
  marketCode: string;
  currencyCode: string;
  paidOnDate: string;
  amountDecimal: string;
  grossAmountDecimal: string;
  frankedAmountDecimal: string | null;
  unfrankedAmountDecimal: string | null;
  frankingCreditsDecimal: string | null;
  residentWithholdingTaxDecimal: string | null;
  nonResidentWithholdingTaxDecimal: string | null;
  goesExOnDate: string | null;
  state: string | null;
  confirmed: boolean | null;
  trust: boolean | null;
  nonTaxable: boolean | null;
  comments: string | null;
  exchangeRateDecimal: string | null;
}>;

export type SharesightListParams = Readonly<{
  from?: string;
  to?: string;
}>;
