// BRK-003: barrel for the Sharesight GET-only client foundation. Nothing
// exported here can send a non-GET Sharesight data request; the sole
// non-GET capability (`token.ts`'s internal POST to the OAuth token
// endpoint) is never re-exported -- only its `SharesightTokenProvider`
// result type/factory are, so a consumer of this barrel only ever receives
// an already-negotiated access token, never the POST capability itself.

export type {
  SharesightError,
  SharesightErrorKind,
  SharesightFetchEvidence,
  SharesightHolding,
  SharesightListParams,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
  SharesightTradeType,
} from "./contracts.ts";

export {
  SharesightNonGetAttemptError,
  sharesightGet,
  type SharesightFetcher,
  type SharesightGetInit,
} from "./transport.ts";

export {
  assertSharesightTokenUrl,
  createSharesightTokenProvider,
  DEFAULT_SHARESIGHT_TOKEN_URL,
  SharesightTokenUrlRejectedError,
  validateSharesightTokenUrlShape,
  type SharesightAccessToken,
  type SharesightTokenClientOptions,
  type SharesightTokenProvider,
  type SharesightTokenUrlValidationOptions,
} from "./token.ts";

export {
  createSharesightClient,
  SharesightBaseUrlRejectedError,
  type SharesightClient,
  type SharesightClientOptions,
} from "./client.ts";

export {
  parseSharesightHoldings,
  parseSharesightPayouts,
  parseSharesightPortfolios,
  parseSharesightTrades,
} from "./parse.ts";
