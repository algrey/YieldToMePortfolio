// BRK-012A: a narrow, single-purpose live read establishing which
// Sharesight API endpoints expose (a) historical DAILY prices per
// instrument, and (b) the CURRENT ~20-minute-delayed price for a holding --
// the owner directive to move pricing from Yahoo to Sharesight depends on
// this evidence. Mirrors `sharesight-fx-rate-spike.mjs`'s structure (token
// acquisition, sealed GET-only client, no-values discipline) -- see that
// file's header comment for the full grant-fallback rationale, which this
// script does not repeat.
//
// This is EVIDENCE ONLY: no schema, no pipeline, no persistence -- it never
// writes to `price_observations` (see `db/repositories/sharesight-price-
// refresh.ts`/`app/sharesight-price-refresh-service.ts` for the actual
// BRK-012B write path this evidence informed).
//
// STATUS (2026-08-20, BRK-012B review finding B4): this script originally
// probed THREE candidate routes. `listUserInstruments` was PROMOTED to a
// typed, validated `domain/sharesight/client.ts` method (Probe A below now
// calls it exactly the way production code does) -- still live/useful to
// re-probe (e.g. the still-outstanding market-hours freshness re-run, see
// docs/ARCHITECTURE.md §8.2). `listInstrumentPrices` was CONFIRMED DEAD (a
// hard HTTP 406 gate, exhaustively re-tested) and REMOVED from the client
// entirely -- the probes that exercised it (and a related
// `listUserInstruments` overload probe that relied on a param the
// promotion also removed) were deleted here rather than left as
// silently-broken dead code; see the deletion note where Probe C begins
// below. `getPortfolioValuation` remains an unpromoted raw evidence probe,
// unchanged.
//
// THE NO-VALUES RULE, NARROWED FOR THIS SPIKE (mirrors
// sharesight-fx-rate-spike.mjs's own narrowing): this script's whole point
// IS to establish price/date/currency/freshness semantics, so it prints a
// SMALL, BOUNDED number of price points -- date, price, currency, and (for
// the "current price" candidates) an update timestamp -- because that is
// the live evidence BRK-012A needs. Prices are not tax data. Other than the
// one permitted refresh-token line below, this script still NEVER prints:
// any payout/dividend amount, franking/withholding figure, cost basis,
// trade brokerage/value, or an owner name. Sharesight's own internal
// numeric ids (instrument id, holding id, portfolio id) are treated as safe
// to print here (they are not tax data and are needed to correlate
// evidence across probes) -- narrower than the FX spike, which omitted ids
// entirely because it had no need for them; this spike's whole purpose is
// confirming per-instrument identity/currency/date alignment, so ids are
// load-bearing evidence, not incidental exposure.
//
// THE ONE PERMITTED SECRET OUTPUT (same carve-out as
// sharesight-read-spike.mjs's header comment): if a successful token
// exchange returns a refresh token, `printRotatedRefreshToken` below prints
// an instruction to add `SHARESIGHT_REFRESH_TOKEN=<value>` to `.dev.vars`,
// on its own clearly marked line, and NOWHERE else. This is deliberate, not
// an oversight of the no-values rule above -- an authorization code is
// one-time and short-lived, so without persisting the refresh token it
// returns, every future run would need the owner to fetch a brand new code
// by hand. The owner runs this script locally and is the sole intended
// reader of its output; `.dev.vars` is gitignored.
//
// HOW TO RUN
//   node --experimental-strip-types scripts/sharesight-price-spike.mjs
//
// Requires the same credentials as sharesight-read-spike.mjs (see that
// file's header comment): SHARESIGHT_CLIENT_ID/SHARESIGHT_CLIENT_SECRET
// always, plus SHARESIGHT_REFRESH_TOKEN or SHARESIGHT_AUTH_CODE +
// SHARESIGHT_REDIRECT_URI depending on which grant this app registration
// supports. Read from process.env or a gitignored .dev.vars file.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSharesightClient,
  createSharesightTokenProvider,
  deriveShapeEvidence,
} from "../domain/sharesight/index.ts";
import { shouldFallBackToAuthorizationCode } from "../domain/sharesight/token-strategy.ts";
import { parseDevVars } from "./dev-vars.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const devVarsPath =
  process.env.SHARESIGHT_DEV_VARS_PATH ?? join(repoRoot, ".dev.vars");
const devVars = parseDevVars(devVarsPath);

const clientId =
  process.env.SHARESIGHT_CLIENT_ID || devVars.SHARESIGHT_CLIENT_ID;
const clientSecret =
  process.env.SHARESIGHT_CLIENT_SECRET || devVars.SHARESIGHT_CLIENT_SECRET;
const authCode =
  process.env.SHARESIGHT_AUTH_CODE || devVars.SHARESIGHT_AUTH_CODE;
const redirectUri =
  process.env.SHARESIGHT_REDIRECT_URI || devVars.SHARESIGHT_REDIRECT_URI;
const refreshToken =
  process.env.SHARESIGHT_REFRESH_TOKEN || devVars.SHARESIGHT_REFRESH_TOKEN;

if (!clientId || !clientSecret) {
  console.error(
    "Missing SHARESIGHT_CLIENT_ID/SHARESIGHT_CLIENT_SECRET -- nothing was sent. See sharesight-read-spike.mjs's header comment for the full credentials story.",
  );
  process.exit(1);
}

function printRotatedRefreshToken(token) {
  console.log("");
  console.log(
    "=== SHARESIGHT REFRESH TOKEN ISSUED -- SAVE THIS NOW, IT WILL NOT BE SHOWN AGAIN ===",
  );
  console.log(`SHARESIGHT_REFRESH_TOKEN=${token}`);
  console.log(
    "=== add the line above to your local .dev.vars (gitignored) -- never commit it ===",
  );
  console.log("");
}

const KIND_HINTS = {
  authentication: "authentication rejected, HTTP 401/400-shaped",
  entitlement: "entitlement/plan gap, HTTP 403-shaped",
  rate_limit: "rate limited, HTTP 429-shaped",
  invalid_response: "response did not match the expected shape",
  timeout: "request timed out",
  transient_upstream: "transient upstream error, HTTP 5xx-shaped",
  non_get_rejected: "a non-GET request was structurally rejected pre-send",
};

async function acquireSharesightToken() {
  if (refreshToken) {
    console.log("token strategy: using SHARESIGHT_REFRESH_TOKEN.");
    const provider = createSharesightTokenProvider({
      clientId,
      clientSecret,
      grantType: "refresh_token",
      refreshToken,
      onRefreshTokenRotated: printRotatedRefreshToken,
    });
    return {
      provider,
      grantUsed: "refresh_token",
      result: await provider.getAccessToken(),
    };
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
      "token strategy: client_credentials was rejected and SHARESIGHT_AUTH_CODE is set, but SHARESIGHT_REDIRECT_URI is missing -- cannot fall back.",
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
  return {
    provider: authCodeProvider,
    grantUsed: "authorization_code",
    result: await authCodeProvider.getAccessToken(),
  };
}

function logFailure(label, result) {
  const hint = KIND_HINTS[result.error.kind] ?? result.error.kind;
  console.log(
    `${label}: FAILED (${result.error.kind} -- ${hint}${
      result.error.retryable ? ", retryable" : ", not retryable"
    })`,
  );
}

/** Minutes between an ISO timestamp and now -- a computed number, not a
 * printed raw value, used only to characterize freshness/delay. */
function minutesSince(isoTimestamp, now) {
  const then = Date.parse(isoTimestamp);
  if (!Number.isFinite(then)) return null;
  return Math.round((now.getTime() - then) / 60_000);
}

// `summarizeDateGaps` (date-spacing analysis for a `last_traded_on` list)
// and `MAX_PROBED_INSTRUMENTS` were removed 2026-08-20 (BRK-012B review
// finding B4) alongside Probes B/B2 below -- both existed solely to serve
// `listInstrumentPrices`, a route BRK-012B's client removed entirely (a
// confirmed hard HTTP 406 gate, not a fixable request-shape mismatch; see
// docs/ARCHITECTURE.md §8.2). Keeping dead helpers only used by deleted
// probe code around risks exactly the "fabricated-looking result" hazard
// this review finding named.

const MAX_PRINTED_POINTS = 8;

async function main() {
  console.log("acquire token: attempting...");
  const {
    provider: tokenProvider,
    grantUsed,
    result: tokenResult,
  } = await acquireSharesightToken();

  if (!tokenResult.ok) {
    logFailure("acquire token", tokenResult);
    console.error("Cannot proceed without a token; stopping.");
    process.exit(1);
  }
  console.log(`acquire token: ok via ${grantUsed} grant.`);

  const client = createSharesightClient({
    tokenProvider,
    // Diagnostic-only, transport metadata (never a body value) -- mirrors
    // the BRK-008 discipline that diagnosed the original mis-versioned
    // listPayouts 404 the same way. Used below only to explain a probe
    // that returns invalid_response with no other evidence.
    onBodyParseDiagnostic: (endpoint, diagnostic) => {
      console.log(
        `  [diagnostic] ${endpoint}: httpStatus=${diagnostic.httpStatus} contentType=${diagnostic.contentType ?? "?"} bodyBytes=${diagnostic.bodyBytes} redirected=${diagnostic.redirected}`,
      );
    },
  });
  const now = new Date();

  const portfoliosResult = await client.listPortfolios();
  if (!portfoliosResult.ok) {
    logFailure("listPortfolios", portfoliosResult);
    console.error("Cannot proceed without a portfolio list; stopping.");
    process.exit(1);
  }
  console.log(`portfolios: ${portfoliosResult.value.length} found.`);
  const portfolio = portfoliosResult.value[0];
  if (!portfolio) {
    console.error("No portfolios on this account; stopping.");
    process.exit(1);
  }
  console.log(
    `using portfolio id=${portfolio.id} currency=${portfolio.currencyCode} for the probes below.`,
  );

  // --- Resolve real held instrument ids (for the historical-prices probe
  // below) via the EXISTING confirmed getPortfolioHoldings endpoint --
  // BRK-009A's sharesightInstrumentId field. No holding quantity/value is
  // ever read or printed here, only the instrument id needed to scope the
  // next probe.
  const holdingsResult = await client.getPortfolioHoldings(portfolio.id);
  const instrumentIds = [];
  if (holdingsResult.ok) {
    console.log(`holdings: ${holdingsResult.value.length} found.`);
    for (const holding of holdingsResult.value) {
      if (
        holding.sharesightInstrumentId &&
        !instrumentIds.includes(holding.sharesightInstrumentId)
      ) {
        instrumentIds.push(holding.sharesightInstrumentId);
      }
    }
    console.log(
      `holdings with a resolvable sharesightInstrumentId: ${instrumentIds.length}/${holdingsResult.value.length}.`,
    );
  } else {
    logFailure("getPortfolioHoldings", holdingsResult);
  }

  // === Probe A: listUserInstruments -- candidate for (b) current price ===
  // BRK-012B (2026-08-20): `listUserInstruments` was promoted from a raw
  // evidence probe to a TYPED, VALIDATED client method
  // (`domain/sharesight/client.ts`) -- `result.value` is now a parsed
  // `SharesightUserInstrument[]` directly (camelCase fields), never the raw
  // `{instruments: [...]}` envelope this probe originally inspected. Updated
  // in place rather than removed, since the route itself is still live and
  // useful to re-probe (e.g. a market-hours freshness re-run, still
  // outstanding per docs/ARCHITECTURE.md §8.2).
  console.log(
    "\n=== Probe A: listUserInstruments (GET /user_instruments.json, v2) ===",
  );
  if (typeof client.listUserInstruments !== "function") {
    console.log("listUserInstruments: not available on this client build.");
  } else {
    const result = await client.listUserInstruments();
    if (!result.ok) {
      logFailure("listUserInstruments", result);
    } else {
      const list = result.value;
      console.log(
        `listUserInstruments: ok, shape = ${JSON.stringify(deriveShapeEvidence(list))}`,
      );
      console.log(
        `listUserInstruments: ${list.length} instrument(s) returned.`,
      );
      let printed = 0;
      for (const item of list) {
        if (printed >= MAX_PRINTED_POINTS) break;
        const updatedAtMinutesAgo = item.currentPriceUpdatedAt
          ? minutesSince(item.currentPriceUpdatedAt, now)
          : null;
        console.log(
          `  instrument_id=${item.id} currency=${item.currencyCode} current_price=${item.currentPriceDecimal} current_price_updated_at=${item.currentPriceUpdatedAt} (${updatedAtMinutesAgo === null ? "n/a" : `${updatedAtMinutesAgo}m ago`})`,
        );
        printed += 1;
      }
    }
  }

  // === Probes B/B2/A2: HISTORICAL, REMOVED (2026-08-20, BRK-012B review
  // finding B4) ===
  // These three probes are DELETED, not merely disabled, per the review
  // ruling that they must never be able to "emit fabricated-looking
  // results or burn needless [live API] calls":
  //   - Probe B (`listInstrumentPrices` recent/deep-history reads) and
  //     Probe B2 (its content-negotiation/path/query follow-up sweep)
  //     probed a route BRK-012B's client removed entirely --
  //     `listInstrumentPrices` no longer exists on `SharesightClient` at
  //     all (see `domain/sharesight/client.ts`'s header comment). The
  //     route's conclusion is not just probed-and-inconclusive, it is
  //     CONFIRMED DEAD (a hard HTTP 406 gate across every policy-compliant
  //     Accept/path/query variant tried) -- see docs/ARCHITECTURE.md §8.2's
  //     BRK-012A follow-up entry for the full per-variant status table.
  //     Re-running these probes cannot produce new evidence, only burn
  //     Sharesight API budget against a route this codebase will not call.
  //   - Probe A2 (`listUserInstruments`'s undocumented date/history
  //     overload probe) called `client.listUserInstruments({ extraParams })`
  //     -- but BRK-012B's promoted, typed `listUserInstruments()` takes NO
  //     parameters at all (the probe-only `extraParams` passthrough was
  //     removed along with the rest of BRK-012A's spike-only params). A
  //     JS call site passing an extra argument to a function that ignores
  //     it does not error -- every "variant" in this probe would silently
  //     collapse into the SAME plain request, four times, each mislabelled
  //     with a distinct param name that was never actually sent. That is
  //     exactly the "fabricated-looking result" this review finding names:
  //     the printed output would claim four param overloads were tested
  //     when only one, unparametrized, request was ever made. The
  //     conclusion this probe already reached (`listUserInstruments` is
  //     current-only; unrecognized params are silently ignored) is already
  //     documented in docs/ARCHITECTURE.md §8.2 and does not need
  //     re-confirming through a broken probe.
  // Live evidence from all three is preserved in docs/ARCHITECTURE.md §8.2
  // (dated entries) and in this file's own git history -- deletion here
  // does not lose that evidence, it only removes a stale, now-inaccurate
  // re-probe capability.

  // === Probe C: getPortfolioValuation -- alternate candidate for (b) ===
  console.log(
    "\n=== Probe C: getPortfolioValuation (GET /portfolios/:id/valuation.json, v2) ===",
  );
  if (typeof client.getPortfolioValuation !== "function") {
    console.log("getPortfolioValuation: not available on this client build.");
  } else {
    const result = await client.getPortfolioValuation(portfolio.id);
    if (!result.ok) {
      logFailure("getPortfolioValuation", result);
    } else {
      const body = result.value;
      console.log(
        `getPortfolioValuation: ok, envelope shape = ${JSON.stringify(deriveShapeEvidence(body))}`,
      );
      // Live shape (2026-08-20) differs from the third-party doc example:
      // real top-level `balance_date` (not nested under
      // `portfolio_valuation`) and `holdings[]` (not
      // `portfolio_valuation_holdings`) -- both handled below with a
      // doc-shape fallback so this still degrades gracefully if the
      // account/API version ever reverts to the documented shape.
      const holdings =
        body && typeof body === "object"
          ? (Array.isArray(body.holdings) && body.holdings) ||
            (Array.isArray(body.portfolio_valuation_holdings) &&
              body.portfolio_valuation_holdings) ||
            null
          : null;
      const balanceDate =
        body && typeof body === "object"
          ? (body.balance_date ??
            body.portfolio_valuation?.balance_date ??
            null)
          : null;
      console.log(`  balance_date=${balanceDate ?? "?"}`);
      if (holdings) {
        let printed = 0;
        for (const item of holdings) {
          if (printed >= MAX_PRINTED_POINTS) break;
          if (!item || typeof item !== "object") continue;
          // `instrument_price`, if the doc-example field is actually
          // present, is printed directly; otherwise this account's real
          // shape only carries `value`/`quantity`, so a per-share price is
          // DERIVED here (never the raw quantity/value pair, which reveals
          // position size) -- kept within the same narrow price-only
          // exception documented at the top of this file.
          const derivedPrice =
            typeof item.instrument_price === "number"
              ? item.instrument_price
              : typeof item.value === "number" &&
                  typeof item.quantity === "number" &&
                  item.quantity !== 0
                ? item.value / item.quantity
                : null;
          console.log(
            `    instrument_id=${item.instrument_id ?? "?"} price=${derivedPrice ?? "?"}${
              typeof item.instrument_price !== "number" && derivedPrice !== null
                ? " (derived: value/quantity)"
                : ""
            }`,
          );
          printed += 1;
        }
      }
    }
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error("Unexpected error:", error?.message ?? error);
  process.exit(1);
});
