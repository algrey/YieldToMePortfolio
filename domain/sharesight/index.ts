// BRK-003: barrel for the Sharesight GET-only client foundation.
// `createSharesightClient` (and `createSharesightTokenProvider`, which only
// ever hands back an already-negotiated access token) are the ONLY public
// ways to reach Sharesight through this barrel. `transport.ts`'s raw
// `sharesightGet` primitive is deliberately NOT re-exported here: it takes a
// caller-controlled URL with no host pin of its own (that pin lives in
// `client.ts`), so a direct caller with a hand-built Authorization header
// could otherwise aim it anywhere and leak a token. `sharesightGet` and
// `SharesightNonGetAttemptError` remain importable from `./transport.ts`
// directly for internal/test use, but are package-internal, not part of
// this barrel's public surface. See docs/ARCHITECTURE.md §8.2.

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

// `SharesightFetcher` is re-exported type-only because it's part of the
// public shape of `SharesightClientOptions.fetcher` below; it carries no
// runtime capability of its own.
export type { SharesightFetcher } from "./transport.ts";

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
