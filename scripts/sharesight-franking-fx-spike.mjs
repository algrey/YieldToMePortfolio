// BRK-011 evidence spike: does Sharesight's payout wire carry an
// AUD-converted franking figure (tier 1 of the owner's binding cascade), and
// -- when franking IS present on a foreign-currency payout -- is it
// denominated in the payout's own currency (which would let tier 2 reuse
// BRK-010's existing stored `exchange_rate` mechanics) or something else?
//
// Documentation-derived groundwork (2026-08-21, `markcatley/sharesight.rs`
// `api_data_2.json`, `ListPortfolioPayouts`, third-party Swagger-derived
// docs, not Sharesight's own artifact -- same source BRK-008 already used
// for the v2 payouts route discovery, see docs/ARCHITECTURE.md §8.2): the
// documented response names a `payouts.tax_credit` field ("The payout tax
// credit amount. Always returned in the portfolio currency.") that
// `domain/sharesight/parse.ts` has never captured -- only `franking_credits`
// was LIVE-CONFIRMED by BRK-008's own pass and is currently parsed. This
// script checks LIVE whether `tax_credit` (or any other undocumented field)
// actually appears on the wire, independent of the already-parsed fields.
//
// REVIEW FINDING B1 FIX (2026-08-21): the first version of this script
// bypassed the sealed client with a raw `fetch()` -- a non-negotiable
// AGENTS.md violation ("all Sharesight traffic goes through the dedicated
// GET-only client module"). Both reads now go through
// `domain/sharesight/index.ts`'s `createSharesightClient`: `listPortfolios()`
// (already typed) for portfolios, and a NEW spike-only, unpromoted,
// RAW-passthrough method, `client.getPayoutsRaw`, for payouts -- the typed
// `listPayouts()` silently drops any field `parse.ts` doesn't capture
// (exactly `tax_credit`), so this spike needs the RAW body, not the parsed
// one. `getPayoutsRaw` is documented in `domain/sharesight/client.ts` as
// spike-only, mirroring BRK-012A's identical `getPortfolioValuation`
// precedent (RAW parsed JSON, no domain contract, never promoted, never
// consumed by production code) -- the same in-module pattern this codebase
// already uses whenever a spike needs to see a shape the typed contract
// doesn't cover yet.
//
// REVIEW FINDING B2 FIX (2026-08-21): the first version of this script only
// ever inspected FOREIGN-currency payouts (`if (!isForeign) continue`) --
// but all 10 of the owner's foreign (USD) payouts are UNFRANKED, so an
// absent franking field on THEM proves nothing about whether Sharesight
// ever populates a franking-shaped field for THIS account at all. This
// version additionally checks `tax_credit`/`franking_credits` presence on
// every NATIVE (AUD) payout too, split by whether `franking_credits` is
// PRESENT AND NONZERO ("franked", DIV-007's established evidence: ~60 of
// the owner's AUD payouts) vs PRESENT AND ZERO/ABSENT ("unfranked") --
// mirroring DIV-007's own investigation. The nonzero comparison
// (`franking_credits !== 0`) is used ONLY to sort a payout into a COUNT
// bucket; the comparison result (a boolean) is never printed as an amount,
// matching this script's existing (unchanged) ratio-bucket precedent below,
// which already performed the identical style of internal-only value
// comparison.
//
// THE NO-VALUES RULE, NARROWED FOR THIS SPIKE (mirrors
// sharesight-fx-rate-spike.mjs's precedent): this script prints field
// NAMES (via `deriveShapeEvidence`, pure/values-safe -- see
// domain/sharesight/shape-evidence.ts's privacy contract), `currency`,
// `paid_on`, and `exchange_rate` VALUES (rates/dates are not tax data), and
// PRESENCE booleans and COUNTS for franking-shaped fields. It additionally
// computes a DIMENSIONLESS RATIO between two franking-shaped amount fields
// when both are present on a foreign payout and prints only a BUCKETED
// LABEL for that ratio (not the ratio's numeric value, and never either
// amount) -- this is the one way to empirically tell "same currency as the
// payout" (ratio ~1) apart from "converted to the portfolio's currency via
// the stored exchange_rate" (ratio ~exchange_rate) without ever revealing a
// real dollar figure. NO amount is ever printed as a number: no
// `amount`/`gross_amount`/`franked_amount`/`unfranked_amount`/
// `franking_credits`/`tax_credit`/withholding value, and no
// id/holding_id/symbol/instrument name.
//
// HOW TO RUN
//   node --experimental-strip-types scripts/sharesight-franking-fx-spike.mjs
//
// Requires the same credentials as sharesight-read-spike.mjs / the
// sibling sharesight-fx-rate-spike.mjs (see those files' header comments):
// SHARESIGHT_CLIENT_ID/SHARESIGHT_CLIENT_SECRET always, plus
// SHARESIGHT_REFRESH_TOKEN or SHARESIGHT_AUTH_CODE + SHARESIGHT_REDIRECT_URI
// depending on which grant this app registration supports. Read from
// process.env or a gitignored .dev.vars file -- never printed. Fails
// closed with a clear, exit-1 message before any network call when no
// credentials are configured (see tests/brk-011.test.ts's dry-path drill,
// mirroring tests/brk-008.test.ts's identical precedent for the other
// spikes).
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
    "Missing Sharesight credentials -- nothing was sent. Set SHARESIGHT_CLIENT_ID/SHARESIGHT_CLIENT_SECRET (in process.env or a gitignored .dev.vars file). See sharesight-read-spike.mjs's header comment for the full credentials story.",
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

/** Field names this script is willing to name as "franking-shaped" for the
 * presence/ratio checks below -- a closed, small allowlist, not an
 * open-ended dump of every key. */
const FRANKING_SHAPED_FIELDS = [
  "franked_amount",
  "unfranked_amount",
  "franking_credits",
  "tax_credit",
  "resident_withholding_tax",
  "non_resident_withholding_tax",
];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function presenceOf(payout) {
  const presence = {};
  for (const field of FRANKING_SHAPED_FIELDS) {
    presence[field] =
      field in payout && payout[field] !== null && payout[field] !== undefined;
  }
  return presence;
}

/** Buckets a dimensionless ratio between two franking-shaped amounts into a
 * label ONLY -- the ratio's own numeric value is never printed, only which
 * bucket it falls in, per this script's header comment. */
function bucketRatio(ratio, exchangeRate) {
  if (!isFiniteNumber(ratio)) return "not computable";
  if (Math.abs(ratio - 1) <= 0.05) return "~1 (same-currency-shaped)";
  if (isFiniteNumber(exchangeRate) && exchangeRate > 0) {
    const rel = Math.abs(ratio - exchangeRate) / exchangeRate;
    if (rel <= 0.05) return "~exchange_rate (converted-to-portfolio-shaped)";
  }
  return "other (inconclusive)";
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

  // B1 fix: every read goes through the sealed client -- no raw fetch, no
  // hand-built Authorization header, anywhere in this script.
  const client = createSharesightClient({ tokenProvider });

  const portfoliosResult = await client.listPortfolios();
  if (!portfoliosResult.ok) {
    console.error(
      `Cannot proceed without a portfolio list; stopping (${portfoliosResult.error.kind}).`,
    );
    process.exit(1);
  }
  const portfolios = portfoliosResult.value;
  console.log(`portfolios: ${portfolios.length} found.`);

  let totalPayouts = 0;
  let foreignPayouts = 0;
  let foreignWithAnyFranking = 0;
  let foreignWithTaxCredit = 0;
  let foreignWithFrankingCredits = 0;
  let nativeFrankedCount = 0;
  let nativeFrankedWithTaxCredit = 0;
  let nativeUnfrankedOrAbsentCount = 0;
  let nativeUnfrankedWithTaxCredit = 0;
  const shapesSeen = new Set();

  for (const portfolio of portfolios) {
    const portfolioId = portfolio.id;
    const portfolioCurrency = portfolio.currencyCode;

    const payoutsResult = await client.getPayoutsRaw(portfolioId);
    if (!payoutsResult.ok) {
      console.log(
        `portfolio payouts: unavailable (${payoutsResult.error.kind})`,
      );
      continue;
    }
    const body = payoutsResult.value;
    const payouts = Array.isArray(body?.payouts) ? body.payouts : [];
    totalPayouts += payouts.length;

    for (const payout of payouts) {
      if (typeof payout !== "object" || payout === null) continue;
      const currency = payout.currency;
      const isForeign =
        typeof currency === "string" &&
        typeof portfolioCurrency === "string" &&
        currency !== portfolioCurrency;

      // Field-NAME-only shape (typeof leaves, never values) -- see
      // domain/sharesight/shape-evidence.ts's privacy contract. Collected
      // for every payout, foreign or native, so the printed shape set
      // reflects the whole account, not just the foreign subset.
      shapesSeen.add(JSON.stringify(deriveShapeEvidence(payout)));

      const presence = presenceOf(payout);

      if (!isForeign) {
        // B2 fix: does `tax_credit` (or any franking-shaped field) ever
        // appear on this account's wire AT ALL, regardless of currency?
        // Bucketed by whether the payout is FRANKED (DIV-007's established
        // evidence: `franking_credits` present and nonzero) -- the
        // comparison result is a boolean used only to pick a COUNT bucket,
        // never printed as an amount, mirroring the ratio-bucket
        // computation below's identical internal-only-comparison
        // precedent.
        const franked =
          presence.franking_credits &&
          isFiniteNumber(payout.franking_credits) &&
          payout.franking_credits !== 0;
        if (franked) {
          nativeFrankedCount += 1;
          if (presence.tax_credit) nativeFrankedWithTaxCredit += 1;
        } else {
          nativeUnfrankedOrAbsentCount += 1;
          if (presence.tax_credit) nativeUnfrankedWithTaxCredit += 1;
        }
        continue;
      }

      foreignPayouts += 1;
      const anyFranking =
        presence.franked_amount ||
        presence.unfranked_amount ||
        presence.franking_credits ||
        presence.tax_credit;
      if (anyFranking) foreignWithAnyFranking += 1;
      if (presence.tax_credit) foreignWithTaxCredit += 1;
      if (presence.franking_credits) foreignWithFrankingCredits += 1;

      const exchangeRate = isFiniteNumber(payout.exchange_rate)
        ? payout.exchange_rate
        : null;

      let ratioBucket = "not applicable";
      if (
        presence.tax_credit &&
        presence.franking_credits &&
        isFiniteNumber(payout.franking_credits) &&
        payout.franking_credits !== 0
      ) {
        const ratio = payout.tax_credit / payout.franking_credits;
        ratioBucket = bucketRatio(ratio, exchangeRate);
      }

      console.log(
        `foreign payout: currency=${currency} paid_on=${payout.paid_on ?? "?"} exchange_rate=${exchangeRate ?? "absent"} ` +
          `franked_amount_present=${presence.franked_amount} unfranked_amount_present=${presence.unfranked_amount} ` +
          `franking_credits_present=${presence.franking_credits} tax_credit_present=${presence.tax_credit} ` +
          `resident_withholding_tax_present=${presence.resident_withholding_tax} non_resident_withholding_tax_present=${presence.non_resident_withholding_tax} ` +
          `tax_credit/franking_credits ratio bucket=${ratioBucket}`,
      );
    }
  }

  console.log("");
  console.log(`total payouts observed (all currencies): ${totalPayouts}`);
  console.log(`foreign-currency payouts observed: ${foreignPayouts}`);
  console.log(
    `foreign-currency payouts with ANY franking-shaped field present: ${foreignWithAnyFranking}`,
  );
  console.log(
    `foreign-currency payouts with tax_credit present: ${foreignWithTaxCredit}`,
  );
  console.log(
    `foreign-currency payouts with franking_credits present: ${foreignWithFrankingCredits}`,
  );
  console.log("");
  console.log(
    `native (same-currency) FRANKED payouts observed: ${nativeFrankedCount}`,
  );
  console.log(
    `native FRANKED payouts with tax_credit present: ${nativeFrankedWithTaxCredit}`,
  );
  console.log(
    `native unfranked/absent-franking payouts observed: ${nativeUnfrankedOrAbsentCount}`,
  );
  console.log(
    `native unfranked/absent-franking payouts with tax_credit present: ${nativeUnfrankedWithTaxCredit}`,
  );
  console.log("");
  console.log(
    "distinct field-NAME shapes observed across ALL payouts (typeof leaves only, no values):",
  );
  for (const shape of shapesSeen) {
    console.log(shape);
  }
}

main().catch((error) => {
  console.error("Unexpected error:", error?.message ?? error);
  process.exit(1);
});
