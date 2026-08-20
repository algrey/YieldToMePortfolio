// BRK-012A: a narrow, single-purpose live read establishing which
// Sharesight API endpoints expose (a) historical DAILY prices per
// instrument, and (b) the CURRENT ~20-minute-delayed price for a holding --
// the owner directive to move pricing from Yahoo to Sharesight depends on
// this evidence. Mirrors `sharesight-fx-rate-spike.mjs`'s structure (token
// acquisition, sealed GET-only client, no-values discipline) -- see that
// file's header comment for the full grant-fallback rationale, which this
// script does not repeat.
//
// This is EVIDENCE ONLY (BRK-012A): no schema, no pipeline, no persistence.
// The three candidate routes this script probes
// (`listUserInstruments`/`listInstrumentPrices`/`getPortfolioValuation`)
// are new BRK-012A "evidence probe" methods added to
// `domain/sharesight/client.ts` -- see that file's header comment. They
// deliberately return RAW, unparsed JSON (no `parse.ts` domain contract
// exists for these endpoints yet); typed/validated contracts are BRK-012B's
// job once this evidence is confirmed.
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

/** Analyzes the DATE spacing of a `last_traded_on`/similar date list -- a
 * derived summary (min/max gap in days, span, count), never the dates
 * themselves beyond the small bounded sample already printed elsewhere. */
function summarizeDateGaps(dates) {
  const parsed = dates
    .map((d) => Date.parse(d))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (parsed.length < 2) return null;
  const gapsDays = [];
  for (let i = 1; i < parsed.length; i++) {
    gapsDays.push(Math.round((parsed[i] - parsed[i - 1]) / 86_400_000));
  }
  const spanDays = Math.round(
    (parsed[parsed.length - 1] - parsed[0]) / 86_400_000,
  );
  return {
    count: parsed.length,
    spanDays,
    minGapDays: Math.min(...gapsDays),
    maxGapDays: Math.max(...gapsDays),
  };
}

const MAX_PRINTED_POINTS = 8;
const MAX_PROBED_INSTRUMENTS = 3;

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
      const body = result.value;
      const list =
        body && typeof body === "object" && Array.isArray(body.instruments)
          ? body.instruments
          : null;
      console.log(
        `listUserInstruments: ok, envelope shape = ${JSON.stringify(deriveShapeEvidence(body))}`,
      );
      if (!list) {
        console.log(
          "listUserInstruments: response did not carry an `instruments` array -- documentation assumption not confirmed.",
        );
      } else {
        console.log(
          `listUserInstruments: ${list.length} instrument(s) returned.`,
        );
        let printed = 0;
        for (const item of list) {
          if (printed >= MAX_PRINTED_POINTS) break;
          if (!item || typeof item !== "object") continue;
          const updatedAtMinutesAgo = item.current_price_updated_at
            ? minutesSince(item.current_price_updated_at, now)
            : null;
          console.log(
            `  instrument_id=${item.id ?? "?"} currency=${item.currency_code ?? "?"} current_price=${item.current_price ?? "?"} current_price_updated_at=${item.current_price_updated_at ?? "?"} (${updatedAtMinutesAgo === null ? "n/a" : `${updatedAtMinutesAgo}m ago`})`,
          );
          printed += 1;
        }
      }
    }
  }

  // === Probe B: listInstrumentPrices -- candidate for (a) historical daily
  // prices ===
  console.log(
    "\n=== Probe B: listInstrumentPrices (GET /instruments/:id/prices.json, v2, doc-tagged -mobile) ===",
  );
  if (typeof client.listInstrumentPrices !== "function") {
    console.log("listInstrumentPrices: not available on this client build.");
  } else if (instrumentIds.length === 0) {
    console.log(
      "listInstrumentPrices: no resolvable instrument id from holdings -- skipped.",
    );
  } else {
    const probedIds = instrumentIds.slice(0, MAX_PROBED_INSTRUMENTS);
    for (const instrumentId of probedIds) {
      // Narrow recent-range read first (bounded footprint) -- confirms the
      // endpoint is reachable/entitled at all before requesting deep
      // history.
      const recentResult = await client.listInstrumentPrices(instrumentId, {
        from: "2026-07-01",
        to: "2026-08-20",
        numPoints: 60,
      });
      if (!recentResult.ok) {
        logFailure(
          `listInstrumentPrices(${instrumentId}, recent range)`,
          recentResult,
        );
        continue;
      }
      const recentBody = recentResult.value;
      const recentList =
        recentBody &&
        typeof recentBody === "object" &&
        Array.isArray(recentBody.instrument_prices)
          ? recentBody.instrument_prices
          : null;
      console.log(
        `listInstrumentPrices(${instrumentId}, recent): ok, envelope shape = ${JSON.stringify(deriveShapeEvidence(recentBody))}`,
      );
      if (!recentList) {
        console.log(
          "  response did not carry an `instrument_prices` array -- documentation assumption not confirmed.",
        );
        continue;
      }
      console.log(
        `  ${recentList.length} price point(s) in the recent-range probe.`,
      );
      let printed = 0;
      const recentDates = [];
      for (const point of recentList) {
        if (!point || typeof point !== "object") continue;
        const date = point.last_traded_on ?? null;
        if (date) recentDates.push(date);
        if (printed < MAX_PRINTED_POINTS) {
          console.log(
            `    date=${date ?? "?"} value=${point.value ?? "?"} last_traded_value=${point.last_traded_value ?? "?"}`,
          );
          printed += 1;
        }
      }
      const recentGaps = summarizeDateGaps(recentDates);
      if (recentGaps) {
        console.log(
          `  date-gap summary: count=${recentGaps.count} spanDays=${recentGaps.spanDays} minGapDays=${recentGaps.minGapDays} maxGapDays=${recentGaps.maxGapDays}`,
        );
      }

      // Deep-history read, only for the FIRST resolvable instrument --
      // confirms whether history reaches back to ~2020 and how `num_points`
      // behaves over a long span (BRK-012B's pagination/limits question).
      if (instrumentId === probedIds[0]) {
        const deepResult = await client.listInstrumentPrices(instrumentId, {
          from: "2020-01-01",
          to: "2026-08-20",
          numPoints: 3000,
        });
        if (!deepResult.ok) {
          logFailure(
            `listInstrumentPrices(${instrumentId}, deep history)`,
            deepResult,
          );
        } else {
          const deepBody = deepResult.value;
          const deepList =
            deepBody &&
            typeof deepBody === "object" &&
            Array.isArray(deepBody.instrument_prices)
              ? deepBody.instrument_prices
              : null;
          if (!deepList) {
            console.log(
              "  deep-history probe: response did not carry an `instrument_prices` array.",
            );
          } else {
            const deepDates = deepList
              .map((p) =>
                p && typeof p === "object" ? p.last_traded_on : null,
              )
              .filter(Boolean);
            const deepGaps = summarizeDateGaps(deepDates);
            console.log(
              `  deep-history probe (from=2020-01-01, numPoints=3000): ${deepList.length} point(s) returned.` +
                (deepGaps
                  ? ` date-gap summary: spanDays=${deepGaps.spanDays} minGapDays=${deepGaps.minGapDays} maxGapDays=${deepGaps.maxGapDays}`
                  : ""),
            );
            if (deepDates.length > 0) {
              const earliest = deepDates.reduce((a, b) => (a < b ? a : b));
              const latest = deepDates.reduce((a, b) => (a > b ? a : b));
              console.log(
                `  earliest date returned=${earliest} latest date returned=${latest}`,
              );
            }
          }
        }
      }
    }
  }

  // === Probe B2 (2026-08-20 follow-up): content-negotiation/path/query
  // variants on listInstrumentPrices, to distinguish a fixable mismatch
  // from a hard gate for the HTTP 406 Probe B observed on every instrument
  // it tried. Coordinator-directed. Every variant is still a plain GET
  // through the sealed transport -- only the Accept header VALUE, path
  // suffix, API-version root, and query param NAME ever change; the
  // request method never does. `-mobile` docs investigation (see below)
  // found no documented header/scope requirement beyond the same Bearer
  // token every other endpoint uses, so no client impersonation (a fake
  // mobile user-agent, an undocumented scope, etc.) is attempted here --
  // only a plain Accept-header value is varied, which is what content
  // negotiation actually inspects.
  console.log(
    "\n=== Probe B2 (follow-up): listInstrumentPrices content-negotiation/path/query variants ===",
  );
  if (typeof client.listInstrumentPrices !== "function") {
    console.log("listInstrumentPrices: not available on this client build.");
  } else if (instrumentIds.length === 0) {
    console.log(
      "listInstrumentPrices: no resolvable instrument id -- skipped.",
    );
  } else {
    const instrumentId = instrumentIds[0];
    console.log(
      `(all B2 variants probed against instrument_id=${instrumentId})`,
    );

    async function tryVariant(label, params) {
      const result = await client.listInstrumentPrices(instrumentId, params);
      if (result.ok) {
        const body = result.value;
        const list =
          body &&
          typeof body === "object" &&
          Array.isArray(body.instrument_prices)
            ? body.instrument_prices
            : null;
        console.log(
          `  [${label}] 200 OK -- envelope shape = ${JSON.stringify(deriveShapeEvidence(body))}${list ? ` (${list.length} point(s))` : ""}`,
        );
        if (list && list.length > 0) {
          const dates = list
            .map((p) => (p && typeof p === "object" ? p.last_traded_on : null))
            .filter(Boolean);
          const gaps = summarizeDateGaps(dates);
          console.log(
            `    sample: date=${list[0]?.last_traded_on ?? "?"} value=${list[0]?.value ?? "?"} last_traded_value=${list[0]?.last_traded_value ?? "?"}` +
              (gaps
                ? ` | date-gap summary: count=${gaps.count} spanDays=${gaps.spanDays} minGapDays=${gaps.minGapDays} maxGapDays=${gaps.maxGapDays}`
                : ""),
          );
        }
        return true;
      }
      // The [diagnostic] line (httpStatus etc.) already printed via the
      // client-level onBodyParseDiagnostic hook wired above -- this line
      // just attributes it to the variant under test.
      console.log(`  [${label}] FAILED (${result.error.kind})`);
      return false;
    }

    const outcomes = [];
    console.log(
      "-- 1. Accept-header variants (default request otherwise unchanged) --",
    );
    outcomes.push(
      await tryVariant(
        "accept: application/json (baseline, same as Probe B)",
        {},
      ),
    );
    outcomes.push(await tryVariant("accept: */*", { acceptOverride: "*/*" }));
    outcomes.push(
      await tryVariant("accept: <omitted>", { acceptOverride: null }),
    );
    outcomes.push(
      await tryVariant("accept: application/vnd.api+json", {
        acceptOverride: "application/vnd.api+json",
      }),
    );

    console.log("-- 2. Path variants --");
    outcomes.push(
      await tryVariant("path without .json suffix (v2)", { pathSuffix: "" }),
    );
    outcomes.push(
      await tryVariant("v3 base instead of v2 (expected 404 -- undocumented)", {
        apiVersion: "v3",
      }),
    );

    console.log("-- 3. Query param variants (small explicit date range) --");
    outcomes.push(
      await tryVariant("start_date=2026-08-01&end_date=2026-08-20", {
        from: "2026-08-01",
        to: "2026-08-20",
      }),
    );
    outcomes.push(
      await tryVariant(
        "start_date=2026-08-01&end_date=2026-08-20&limit=20 (undocumented limit)",
        { from: "2026-08-01", to: "2026-08-20", limit: 20 },
      ),
    );

    const anyVariantWorked = outcomes.some(Boolean);
    console.log(
      anyVariantWorked
        ? "B2 summary: at least one variant returned 200 (see above for the winning shape)."
        : "B2 summary: EVERY variant above failed the same way as Probe B (see each line's status). Historical dailies via this documented route are NOT reachable from this API client under any header/path/query combination tried.",
    );
  }

  // === Probe A2 (2026-08-20 follow-up): does listUserInstruments accept an
  // undocumented date/history overload (some APIs overload a "list current"
  // route with an as-of/date param)? Coordinator-directed. ===
  console.log(
    "\n=== Probe A2 (follow-up): listUserInstruments undocumented date/history param probe ===",
  );
  if (typeof client.listUserInstruments !== "function") {
    console.log("listUserInstruments: not available on this client build.");
  } else {
    for (const [label, extraParams] of [
      [
        "start_date/end_date",
        { start_date: "2026-08-01", end_date: "2026-08-20" },
      ],
      ["as_of_date", { as_of_date: "2026-08-01" }],
      ["date", { date: "2026-08-01" }],
      ["history=true", { history: "true" }],
    ]) {
      const result = await client.listUserInstruments({ extraParams });
      if (!result.ok) {
        console.log(`  [${label}] FAILED (${result.error.kind})`);
        continue;
      }
      const body = result.value;
      const list =
        body && typeof body === "object" && Array.isArray(body.instruments)
          ? body.instruments
          : null;
      console.log(
        `  [${label}] 200 OK -- ${list ? `${list.length} instrument(s), same shape as Probe A (params silently ignored unless the shape/count differs)` : "no instruments array"}`,
      );
    }
  }

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
