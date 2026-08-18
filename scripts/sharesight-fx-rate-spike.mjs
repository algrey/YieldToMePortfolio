// BRK-010 review finding B1: a narrow, single-purpose live read to resolve
// the UNEVIDENCED direction question in Sharesight payouts' `exchange_rate`
// field -- does it multiply a payout's own-currency amount UP to the
// portfolio's base currency (payout -> portfolio), or the reverse (base ->
// payout)? AUD/USD traded roughly 0.60-0.70 (USD per AUD -- i.e. how many
// USD one AUD buys) through 2024-2026, so an observed `exchange_rate`
// around 1.4-1.7 on a USD payout in an AUD-base portfolio proves the
// multiply-to-AUD (payout -> portfolio) direction; a value around 0.58-0.72
// would prove the inverse.
//
// Reuses BRK-008's token-acquisition strategy and the sealed GET-only
// client (`domain/sharesight/index.ts`) exactly like
// `sharesight-read-spike.mjs` -- see that file's header comment for the
// full grant-fallback rationale, which this script does not repeat.
//
// THE NO-VALUES RULE, NARROWED FOR THIS SPIKE: unlike the general spike,
// this script's whole point IS to print three specific field values for
// USD-currency payout items -- `currency`, `paid_on`, `exchange_rate` --
// because that is the live evidence BRK-010 needs. This is a deliberate,
// narrow exception documented here, not a precedent for printing arbitrary
// fields: NO amounts (`amount`/`gross_amount`/franking/withholding), NO ids
// (`id`/`holding_id`/`portfolio_id`), NO symbols/names -- rates are not tax
// data, but the same "print only what's needed, nothing else" discipline
// applies. Every other Sharesight field stays completely unprinted.
//
// HOW TO RUN
//   node --experimental-strip-types scripts/sharesight-fx-rate-spike.mjs
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

async function main() {
  console.log("acquire token: attempting...");
  const {
    provider: tokenProvider,
    grantUsed,
    result: tokenResult,
  } = await acquireSharesightToken();

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

  const client = createSharesightClient({ tokenProvider });

  const portfoliosResult = await client.listPortfolios();
  if (!portfoliosResult.ok) {
    console.error(
      `Cannot proceed without a portfolio list; stopping (${portfoliosResult.error.kind}).`,
    );
    process.exit(1);
  }
  console.log(`portfolios: ${portfoliosResult.value.length} found.`);

  let usdCount = 0;
  for (const portfolio of portfoliosResult.value) {
    const payoutsResult = await client.listPayouts(portfolio.id);
    if (!payoutsResult.ok) {
      console.log(
        `portfolio payouts: unavailable (${payoutsResult.error.kind})`,
      );
      continue;
    }
    for (const payout of payoutsResult.value) {
      if (payout.currencyCode !== "USD") continue;
      usdCount += 1;
      console.log(
        `USD payout: currency=${payout.currencyCode} paid_on=${payout.paidOnDate} exchange_rate=${payout.exchangeRateDecimal}`,
      );
    }
  }
  console.log(`\ntotal USD-currency payout items observed: ${usdCount}`);
}

main().catch((error) => {
  console.error("Unexpected error:", error?.message ?? error);
  process.exit(1);
});
