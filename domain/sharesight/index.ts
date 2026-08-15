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
  SharesightBodyParseDiagnostic,
  SharesightError,
  SharesightErrorKind,
  SharesightFetchEvidence,
  SharesightHolding,
  SharesightItemFailureDetail,
  SharesightItemFailureEvidence,
  SharesightItemFailureReason,
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
  SHARESIGHT_OOB_REDIRECT_URI,
  SharesightRedirectUriRejectedError,
  SharesightTokenGrantConfigError,
  SharesightTokenUrlRejectedError,
  validateSharesightRedirectUri,
  validateSharesightTokenUrlShape,
  type SharesightAccessToken,
  type SharesightGrantType,
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

// `deriveShapeEvidence` is pure and side-effect free (no fetch, no I/O --
// see shape-evidence.ts's header for its privacy contract), so it is safe
// to export from this barrel unlike transport.ts's raw sharesightGet.
export {
  deriveShapeEvidence,
  type DeriveShapeEvidenceOptions,
} from "./shape-evidence.ts";
