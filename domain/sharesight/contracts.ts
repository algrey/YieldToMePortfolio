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

export type SharesightHolding = Readonly<{
  portfolioId: string;
  instrumentCode: string;
  marketCode: string | null;
  currencyCode: string;
  quantityDecimal: string;
  averageCostDecimal: string | null;
  marketValueDecimal: string | null;
}>;

export type SharesightTradeType = "buy" | "sell" | "other";

export type SharesightTrade = Readonly<{
  id: string;
  portfolioId: string;
  instrumentCode: string;
  marketCode: string | null;
  transactionType: SharesightTradeType;
  transactionDate: string;
  currencyCode: string;
  quantityDecimal: string;
  priceDecimal: string;
  brokerageDecimal: string | null;
}>;

export type SharesightPayout = Readonly<{
  id: string;
  portfolioId: string;
  instrumentCode: string;
  paidOnDate: string;
  currencyCode: string;
  amountDecimal: string;
  frankedAmountDecimal: string | null;
  unfrankedAmountDecimal: string | null;
  taxWithheldDecimal: string | null;
}>;

export type SharesightListParams = Readonly<{
  from?: string;
  to?: string;
}>;
