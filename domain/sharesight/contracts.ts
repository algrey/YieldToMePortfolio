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

export type SharesightError = Readonly<{
  kind: SharesightErrorKind;
  message: string;
  retryable: boolean;
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

export type SharesightPortfolio = Readonly<{
  id: string;
  name: string;
  currencyCode: string;
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
