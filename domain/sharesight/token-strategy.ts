// BRK-008: pure grant-selection/fallback strategy for the Sharesight live-
// read spike script (`scripts/sharesight-read-spike.mjs`), extracted into
// its own module so it is unit-testable without any network I/O, `.dev.vars`
// parsing, or the script's own process/env plumbing. Nothing here touches
// `fetch`, a `URL`, or a credential value -- only the shape of what's
// configured (booleans) and the typed error kind an exchange already
// produced.
//
// This module is intentionally NOT re-exported from `domain/sharesight/`'s
// barrel: it decides which OAuth grant to *attempt*, but never itself
// reaches Sharesight (that remains solely `createSharesightTokenProvider`,
// via `token.ts`) -- see that barrel's comment on why only network-reaching
// primitives are gated behind it. Importing this module directly (from the
// spike script or a test) is the same pattern already used for
// `scripts/dev-vars.mjs`'s `parseDevVars`.

import type { SharesightError } from "./contracts.ts";

export type SharesightSpikeCredentialShape = Readonly<{
  hasRefreshToken: boolean;
  hasAuthCode: boolean;
}>;

export type SharesightSpikeInitialGrant =
  "refresh_token" | "client_credentials";

/**
 * Which grant the spike should attempt FIRST. A present refresh token
 * always wins: it is durable (the app's registered grants may or may not
 * include client_credentials at all) and never consumes a one-time
 * authorization code. With no refresh token, `client_credentials` is
 * attempted first -- whether it is actually enabled for this app
 * registration is exactly what BRK-008 is finding out -- with
 * `authorization_code` as the documented fallback (see
 * `shouldFallBackToAuthorizationCode`), never guessed ahead of time.
 */
export function decideInitialGrant(
  shape: SharesightSpikeCredentialShape,
): SharesightSpikeInitialGrant {
  return shape.hasRefreshToken ? "refresh_token" : "client_credentials";
}

/**
 * A "grant-rejection" is the token endpoint refusing the GRANT itself --
 * disabled/unsupported grant type, wrong client id/secret, invalid client --
 * which `requestNewToken` (`token.ts`) already maps to the `authentication`
 * kind with `retryable: false` for any 400/401 response. Anything retryable
 * (`timeout`, `rate_limit`, `transient_upstream`) is a network/availability
 * problem, not a grant problem: retrying the SAME grant (or simply
 * surfacing the error) is correct there, never silently spending a one-time
 * authorization code because a request happened to time out.
 */
export function isGrantRejection(error: SharesightError): boolean {
  return error.kind === "authentication" && error.retryable === false;
}

/**
 * Whether the spike should retry via `authorization_code` after
 * `client_credentials` failed. Requires BOTH a genuine grant-rejection
 * (never a network error, per `isGrantRejection`) AND an authorization code
 * actually being configured (`SHARESIGHT_AUTH_CODE` is optional) -- falling
 * back with no code to fall back to would just be a second, identically-
 * shaped failure.
 *
 * BRK-008 refinement, made possible by `token.ts`'s bounded OAuth
 * `error`-code diagnostic (`SharesightError.oauthErrorCode`,
 * docs/ARCHITECTURE.md §8.2): when the token endpoint's error code is
 * PRECISELY known, two of the seven allowlisted codes carry an especially
 * clear signal for THIS decision --
 *  - `unsupported_grant_type` is the textbook confirmation that
 *    client_credentials genuinely isn't enabled for this app registration,
 *    i.e. exactly the case the fallback exists for;
 *  - `invalid_client` means Sharesight rejected the CLIENT itself (a bad
 *    `client_id`/`client_secret`) -- `authorization_code` sends the exact
 *    same `client_id`/`client_secret` in its POST body
 *    (`token.ts`'s `buildGrantRequestBody`), so it would fail identically.
 *    Falling back would only burn the one-time authorization code for a
 *    request that cannot possibly succeed, so this case is skipped
 *    entirely.
 * Any OTHER grant-rejection (including `invalid_grant`,
 * `unauthorized_client`, or an oauthErrorCode the token endpoint didn't
 * return / that didn't match the allowlist) still falls back, unchanged
 * from the original behavior -- this refinement only ADDS a precise skip
 * for the one case that is provably wasteful, never narrows the trigger
 * down to `unsupported_grant_type` alone, since a genuine grant-rejection
 * with an unrecognized or absent error code is still worth attempting the
 * fallback for.
 */
export function shouldFallBackToAuthorizationCode(
  clientCredentialsError: SharesightError,
  hasAuthCode: boolean,
): boolean {
  if (!hasAuthCode || !isGrantRejection(clientCredentialsError)) {
    return false;
  }
  return clientCredentialsError.oauthErrorCode !== "invalid_client";
}
