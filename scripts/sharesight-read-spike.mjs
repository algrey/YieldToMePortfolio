// BRK-008: Sharesight live read spike (owner-assisted, local-only tooling).
//
// WHAT THIS IS FOR
//   Proves the owner's Sharesight User API v3 account is readable via
//   BRK-003's GET-only client: acquire a token, list portfolios, then fetch
//   holdings/trades/payouts for each portfolio. Records which endpoints
//   work, the response shape (field NAMES only), and the two BRK-003 TODOs
//   the client's `parse.ts` flagged as needing a live response to confirm
//   (id numeric-vs-string shape; decimal exponential-notation magnitude).
//   Go/no-go evidence for BRK-004/005.
//
// TOKEN ACQUISITION STRATEGY (BRK-008)
//   The owner's Sharesight app registration uses the authorization-code
//   flow with an out-of-band redirect (Sharesight shows a one-time code in
//   the browser rather than redirecting a callback URL); whether
//   client_credentials is ALSO enabled for this app is exactly what this
//   spike is finding out, so it tries client_credentials first and falls
//   back:
//     1. If `SHARESIGHT_REFRESH_TOKEN` is set (from a prior run -- see
//        below), use the `refresh_token` grant. This is the cheapest,
//        most-durable path and never spends a one-time code.
//     2. Otherwise, attempt `client_credentials`. If the token endpoint
//        rejects the GRANT ITSELF (a typed, non-retryable `authentication`
//        result -- never a network/timeout/rate-limit error, which must
//        never trigger a fallback) AND `SHARESIGHT_AUTH_CODE` +
//        `SHARESIGHT_REDIRECT_URI` are set, retry via `authorization_code`.
//   The grant that actually succeeded is printed. See
//   `domain/sharesight/token-strategy.ts` for the pure fallback-decision
//   logic (unit-tested independently of this script in
//   `tests/brk-003.test.ts`).
//
// HOW TO RUN
//   node --experimental-strip-types scripts/sharesight-read-spike.mjs
//
//   Requires SHARESIGHT_CLIENT_ID / SHARESIGHT_CLIENT_SECRET (Sharesight
//   Settings -> API tab, the owner's MAIN PAID account -- BRK-008), always.
//   Optionally, depending on which grant(s) are available for this app
//   registration:
//     - SHARESIGHT_REFRESH_TOKEN -- a previously issued refresh token; when
//       set, this alone determines the grant used (see strategy above).
//     - SHARESIGHT_AUTH_CODE -- the one-time code Sharesight displayed in
//       the browser for the authorization-code flow (short-lived; request a
//       fresh one right before running this script).
//     - SHARESIGHT_REDIRECT_URI -- must be EXACTLY the redirect URI
//       configured on the app registration; for this OOB registration
//       that's the literal `urn:ietf:wg:oauth:2.0:oob`
//       (`SHARESIGHT_OOB_REDIRECT_URI`).
//   All of the above are read from a gitignored `.dev.vars` file at the
//   repo root (KEY=VALUE per line, `#`-prefixed comments and blank lines
//   ignored -- same shape `wrangler`/`vinext dev` read, though this script
//   parses it itself since it runs outside that toolchain) or from
//   `process.env`, which takes precedence over `.dev.vars` when both are
//   set. `.dev.vars`'s path can be overridden with
//   `SHARESIGHT_DEV_VARS_PATH` (used by this script's own
//   missing-credentials test so it never depends on the ambient repo-root
//   file).
//
//   THE ONE PERMITTED SECRET OUTPUT: if a successful exchange returns a
//   refresh token, this script prints an instruction to add
//   `SHARESIGHT_REFRESH_TOKEN=<value>` to `.dev.vars`, on its own clearly
//   marked line, and NOWHERE else. This is deliberate, not an oversight of
//   the no-values rule below -- an authorization code is one-time and
//   short-lived, so without persisting the refresh token it returns, every
//   future run would need the owner to fetch a brand new code from
//   Sharesight by hand. The owner runs this script locally and is the sole
//   intended reader of its output; `.dev.vars` is gitignored and is exactly
//   where this repo's other local secrets already live (see
//   `domain/sharesight/token.ts`'s `onRefreshTokenRotated` option, which is
//   this script's only source for the value).
//
// THE NO-VALUES RULE (otherwise, without exception)
//   This script reads the owner's real portfolio/holdings/trade/payout
//   data -- tax data (AGENTS.md non-negotiable: secrets/PII never in logs).
//   Other than the one permitted refresh-token line above, it NEVER prints
//   a field VALUE from a Sharesight response, only: typed outcome kinds,
//   item counts, `payloadSha256` hash evidence (already a one-way digest,
//   not a value -- see `SharesightFetchEvidence`), the `typeof` of the
//   first item's `id` field (never its value), a boolean "does this decimal
//   string look exponential" flag (never the decimal itself), and a
//   recursive field-NAME-only shape dump (`Object.keys`, never the
//   corresponding values) of the first item in each list, and -- for an
//   endpoint whose parser fails closed with `invalid_response` -- the
//   `onShapeEvidence`-supplied shape (key names, `typeof` leaves, and
//   format-class-only decimal/exponent annotations; see
//   `domain/sharesight/shape-evidence.ts`'s privacy contract), which this
//   script only ever prints, never derives itself. Do not add a
//   `console.log` anywhere in this file that could print an actual
//   Sharesight field value, an access token, an authorization code, or a
//   client secret.
//
// This script only ever reaches Sharesight through `domain/sharesight`'s
// public barrel (`createSharesightTokenProvider` + `createSharesightClient`)
// -- never `transport.ts`'s raw `sharesightGet` primitive directly, which
// the barrel deliberately does not re-export and an ESLint rule bars
// importing outside the package (BRK-004 review). The barrel's client is
// GET-only by construction (BRK-003): this script cannot issue a write to
// Sharesight even if it tried. `token-strategy.ts` (imported below) is a
// pure grant-selection helper that never itself reaches Sharesight, so it
// is imported directly rather than through the barrel (mirroring
// `dev-vars.mjs`'s `parseDevVars`, also imported directly).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSharesightClient,
  createSharesightTokenProvider,
} from "../domain/sharesight/index.ts";
import { shouldFallBackToAuthorizationCode } from "../domain/sharesight/token-strategy.ts";
import { parseDevVars } from "./dev-vars.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const devVarsPath =
  process.env.SHARESIGHT_DEV_VARS_PATH ?? join(repoRoot, ".dev.vars");
const devVars = parseDevVars(devVarsPath);

// process.env always wins over `.dev.vars` (matches this repo's other
// scripts, e.g. dev-auth-gateway.mjs's `process.env.X ?? default` pattern).
const clientId =
  process.env.SHARESIGHT_CLIENT_ID || devVars.SHARESIGHT_CLIENT_ID;
const clientSecret =
  process.env.SHARESIGHT_CLIENT_SECRET || devVars.SHARESIGHT_CLIENT_SECRET;
// BRK-008: all three optional -- see the strategy comment above.
const authCode =
  process.env.SHARESIGHT_AUTH_CODE || devVars.SHARESIGHT_AUTH_CODE;
const redirectUri =
  process.env.SHARESIGHT_REDIRECT_URI || devVars.SHARESIGHT_REDIRECT_URI;
const refreshToken =
  process.env.SHARESIGHT_REFRESH_TOKEN || devVars.SHARESIGHT_REFRESH_TOKEN;

if (!clientId || !clientSecret) {
  console.error(
    [
      "Missing Sharesight credentials -- nothing was sent.",
      "",
      "Set SHARESIGHT_CLIENT_ID and SHARESIGHT_CLIENT_SECRET, either:",
      "  - as process environment variables, or",
      `  - in a gitignored .dev.vars file at the repo root (${devVarsPath}),`,
      "    one KEY=VALUE per line.",
      "",
      "These come from the owner's Sharesight Settings -> API tab on the",
      "MAIN PAID account (see TASKS.md BRK-008). Never commit .dev.vars,",
      "paste these values into a shared shell, or add them to a fixture.",
      "",
      "Optionally, also set (see this file's header comment):",
      "  SHARESIGHT_REFRESH_TOKEN, or SHARESIGHT_AUTH_CODE +",
      "  SHARESIGHT_REDIRECT_URI, depending on which grant(s) this app",
      "  registration supports.",
    ].join("\n"),
  );
  process.exit(1);
}

/** BRK-008: prints a newly issued refresh token, once, on its own clearly
 * marked line -- the ONE permitted secret output in this script (see the
 * header comment). Never called except as `onRefreshTokenRotated`, which
 * `domain/sharesight/token.ts` only invokes with a value it just validated
 * out of a real token-endpoint response; this function itself never
 * inspects, transforms, or logs it anywhere else. */
function printRotatedRefreshToken(token) {
  console.log("");
  console.log(
    "=== SHARESIGHT REFRESH TOKEN ISSUED -- SAVE THIS NOW, IT WILL NOT BE SHOWN AGAIN ===",
  );
  console.log(`SHARESIGHT_REFRESH_TOKEN=${token}`);
  console.log(
    "=== add the line above to your local .dev.vars (gitignored) -- never commit it, paste it into a shared shell, or log it anywhere else ===",
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// From here on this is the live-read spike itself. Not exercised by
// tests -- tests/brk-008.test.ts only drives the missing-credentials path
// above, which exits before any of this runs.
// ---------------------------------------------------------------------------

/** Recursively collects field NAMES (never values) from a parsed Sharesight
 * item, mirroring `Object.keys` at every nesting level. Leaves are replaced
 * by their `typeof` (or the literal string "null"), never their value. */
function fieldShape(value, seen = new Set()) {
  if (Array.isArray(value)) {
    return value.length > 0 ? [fieldShape(value[0], seen)] : [];
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    /** @type {Record<string, unknown>} */
    const shape = {};
    for (const key of Object.keys(value).sort()) {
      shape[key] = fieldShape(value[key], seen);
    }
    return shape;
  }
  return value === null ? "null" : typeof value;
}

function looksExponential(value) {
  return typeof value === "string" && /e/i.test(value);
}

/** Human-readable hint for each typed error kind, since the sealed client
 * deliberately discards the raw HTTP status in favour of a typed kind
 * (BRK-003) -- this maps back to the HTTP shape a guest/entitlement gap
 * would show up as, without reaching for anything the client doesn't
 * expose. */
const KIND_HINTS = {
  authentication: "authentication rejected, HTTP 401/400-shaped",
  entitlement: "entitlement/plan gap, HTTP 403-shaped",
  rate_limit: "rate limited, HTTP 429-shaped",
  invalid_response: "response did not match the expected shape",
  timeout: "request timed out",
  transient_upstream: "transient upstream error, HTTP 5xx-shaped",
  non_get_rejected: "a non-GET request was structurally rejected pre-send",
};

/** Prints a typed GET result's outcome, item count, and (on success) the
 * first item's field-shape / TODO(BRK-008) diagnostics -- never a value. */
function printOutcome(label, result) {
  if (!result.ok) {
    const hint = KIND_HINTS[result.error.kind] ?? result.error.kind;
    console.log(
      `${label}: unavailable (${result.error.kind} -- ${hint}${
        result.error.retryable ? ", retryable" : ", not retryable"
      })`,
    );
    return;
  }
  const items = result.value;
  console.log(`${label}: ok, ${items.length} item(s)`);
  if (items.length === 0) return;

  const first = items[0];
  console.log(`${label}: first-item field shape (names only, no values):`);
  console.log(JSON.stringify(fieldShape(first), null, 2));

  // TODO(BRK-008) confirmation 1: numeric-vs-string id shape
  // (domain/sharesight/parse.ts). Post-parse, `id` is ALWAYS "string" by
  // construction -- `requiredString` rejects a non-string id outright, so a
  // parse success here only confirms the raw id WAS shaped as a JSON
  // string, never disproves a numeric id (that would instead show up as
  // "unavailable (invalid_response -- ...)" above, with parse.ts's
  // malformed-entry message). This sealed client has no way to inspect the
  // raw un-parsed JSON to go further than that -- see parse.ts's TODO.
  if ("id" in first) {
    console.log(
      `${label}: id typeof = ${typeof first.id} (TODO(BRK-008) numeric-vs-string id confirmation; see parse.ts)`,
    );
  }

  // Regression evidence for the resolved BRK-008 exponent-notation decision
  // (domain/sharesight/parse.ts's decimalString, docs/ARCHITECTURE.md
  // §8.2): a successfully parsed decimal STRING can never contain "e"/"E"
  // any more -- decimalString now rejects exponential-notation output
  // up front rather than reformatting it, so this always reports `false`
  // for anything that reached this point. Kept as a live tripwire (not a
  // TODO -- the question itself is closed) in case that guarantee is ever
  // broken by a future change; reports only whether the parsed decimal
  // STRING contains an "e"/"E" -- never the string itself.
  for (const [field, sample] of Object.entries(first)) {
    if (typeof sample === "string" && /decimal$/i.test(field)) {
      console.log(
        `${label}: ${field} exponential-notation observed = ${looksExponential(
          sample,
        )} (should always be false -- see parse.ts's decimalString)`,
      );
    }
  }
}

/** BRK-008 diagnostic: prints the token endpoint's OAuth `error` code for a
 * failed grant attempt, when `token.ts` was able to identify one -- e.g.
 * "client_credentials rejected (oauth error: unsupported_grant_type)". Never
 * prints anything else from the failure (no `error_description`, no raw
 * body -- see `token.ts`'s `readOAuthErrorCode` and this file's no-values
 * rule); a result with no `oauthErrorCode` (network error, or a body that
 * didn't parse/match the allowlist) prints nothing here. */
function logOAuthErrorCode(grantName, result) {
  if (!result.ok && result.error.oauthErrorCode) {
    console.log(
      `${grantName} rejected (oauth error: ${result.error.oauthErrorCode})`,
    );
  }
}

/**
 * BRK-008: implements the token-acquisition strategy documented in this
 * file's header comment. Returns `{ provider, grantUsed, result }` -- the
 * caller (`main`) is responsible for the exit-on-failure/success logging,
 * this function only decides WHICH grant to use and drives the fallback.
 */
async function acquireSharesightToken() {
  if (refreshToken) {
    console.log(
      "token strategy: SHARESIGHT_REFRESH_TOKEN is set -- using the refresh_token grant.",
    );
    const provider = createSharesightTokenProvider({
      clientId,
      clientSecret,
      grantType: "refresh_token",
      refreshToken,
      onRefreshTokenRotated: printRotatedRefreshToken,
    });
    const result = await provider.getAccessToken();
    logOAuthErrorCode("refresh_token", result);
    return { provider, grantUsed: "refresh_token", result };
  }

  console.log(
    "token strategy: no refresh token configured -- trying client_credentials first.",
  );
  const clientCredentialsProvider = createSharesightTokenProvider({
    clientId,
    clientSecret,
    grantType: "client_credentials",
    onRefreshTokenRotated: printRotatedRefreshToken,
  });
  const clientCredentialsResult =
    await clientCredentialsProvider.getAccessToken();
  if (clientCredentialsResult.ok) {
    return {
      provider: clientCredentialsProvider,
      grantUsed: "client_credentials",
      result: clientCredentialsResult,
    };
  }
  logOAuthErrorCode("client_credentials", clientCredentialsResult);

  // Never retries via a different grant on a network/timeout/rate-limit
  // error -- only a genuine, typed rejection of the client_credentials
  // GRANT itself (see token-strategy.ts's isGrantRejection). BRK-008
  // refinement: an `invalid_client` oauthErrorCode is also excluded here --
  // authorization_code would send the identical client_id/client_secret and
  // fail the same way, so falling back would only burn the one-time code
  // for nothing (see token-strategy.ts's shouldFallBackToAuthorizationCode
  // doc comment for the full rationale).
  if (
    !shouldFallBackToAuthorizationCode(
      clientCredentialsResult.error,
      Boolean(authCode),
    )
  ) {
    return {
      provider: clientCredentialsProvider,
      grantUsed: "client_credentials",
      result: clientCredentialsResult,
    };
  }

  if (!redirectUri) {
    console.log(
      "token strategy: client_credentials was rejected and SHARESIGHT_AUTH_CODE is set, but SHARESIGHT_REDIRECT_URI is missing -- cannot fall back to authorization_code.",
    );
    return {
      provider: clientCredentialsProvider,
      grantUsed: "client_credentials",
      result: clientCredentialsResult,
    };
  }

  console.log(
    `token strategy: client_credentials was rejected (${clientCredentialsResult.error.kind}) -- falling back to authorization_code.`,
  );
  const authCodeProvider = createSharesightTokenProvider({
    clientId,
    clientSecret,
    grantType: "authorization_code",
    code: authCode,
    redirectUri,
    onRefreshTokenRotated: printRotatedRefreshToken,
  });
  const authCodeResult = await authCodeProvider.getAccessToken();
  logOAuthErrorCode("authorization_code", authCodeResult);
  return {
    provider: authCodeProvider,
    grantUsed: "authorization_code",
    result: authCodeResult,
  };
}

async function main() {
  console.log("acquire token: attempting...");
  const {
    provider: tokenProvider,
    grantUsed,
    result: tokenResult,
  } = await acquireSharesightToken();

  // Correlates onFetchEvidence/onShapeEvidence callbacks (fired at most once
  // per call, synchronously within it) back to the endpoint that triggered
  // them. Safe because every call below is sequentially awaited -- never
  // concurrent.
  let evidenceLabel = "unknown";
  const client = createSharesightClient({
    tokenProvider,
    onFetchEvidence: (evidence) => {
      console.log(
        `${evidenceLabel}: evidence payloadSha256=${evidence.payloadSha256} ingestedAt=${evidence.ingestedAt}`,
      );
    },
    // BRK-008: fired ONLY when a parser fails closed with invalid_response
    // -- prints the REAL shape (key names + typeof leaves only, no values;
    // see domain/sharesight/shape-evidence.ts's privacy contract) so a
    // parser built on invented fixtures can be corrected against the actual
    // live response shape.
    onShapeEvidence: (endpoint, shape) => {
      console.log("");
      console.log(
        `=== BRK-008 SHAPE DIAGNOSTIC (${evidenceLabel} / ${endpoint}) -- key names and types only, no values ===`,
      );
      console.log(JSON.stringify(shape, null, 2));
      console.log("=== end shape diagnostic ===");
      console.log("");
    },
    // BRK-008: fired ONLY when a response body was read but did NOT parse
    // as JSON at all (e.g. an HTML page from a misrouted endpoint -- the
    // 2026-08-15 listPayouts symptom this diagnostic exists to catch next
    // time it happens). Metadata only -- content-type, HTTP status, byte
    // count -- never the body itself.
    onBodyParseDiagnostic: (endpoint, diagnostic) => {
      console.log(
        `${evidenceLabel} / ${endpoint}: response body was not valid JSON -- contentType=${diagnostic.contentType} httpStatus=${diagnostic.httpStatus} bodyBytes=${diagnostic.bodyBytes}`,
      );
    },
  });

  async function call(label, fn) {
    evidenceLabel = label;
    try {
      return await fn();
    } finally {
      evidenceLabel = "unknown";
    }
  }

  if (!tokenResult.ok) {
    const hint = KIND_HINTS[tokenResult.error.kind] ?? tokenResult.error.kind;
    console.log(
      `acquire token: unavailable via ${grantUsed} (${tokenResult.error.kind} -- ${hint}${
        tokenResult.error.retryable ? ", retryable" : ", not retryable"
      })`,
    );
    console.error("Cannot proceed without a token; stopping.");
    process.exit(1);
  }
  console.log(`acquire token: ok via ${grantUsed} grant.`);

  const portfoliosResult = await call("portfolios", () =>
    client.listPortfolios(),
  );
  printOutcome("portfolios", portfoliosResult);
  if (!portfoliosResult.ok) {
    console.error("Cannot proceed without a portfolio list; stopping.");
    return;
  }

  let index = 0;
  for (const portfolio of portfoliosResult.value) {
    index += 1;
    console.log(`\n--- portfolio #${index} ---`);

    const holdings = await call(`portfolio #${index} holdings`, () =>
      client.getPortfolioHoldings(portfolio.id),
    );
    printOutcome(`portfolio #${index} holdings`, holdings);

    const trades = await call(`portfolio #${index} trades`, () =>
      client.listTrades(portfolio.id),
    );
    printOutcome(`portfolio #${index} trades`, trades);

    const payouts = await call(`portfolio #${index} payouts`, () =>
      client.listPayouts(portfolio.id),
    );
    printOutcome(`portfolio #${index} payouts`, payouts);
  }
}

await main();
