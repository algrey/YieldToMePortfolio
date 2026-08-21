// MKT-009A: Yahoo authenticated-session evidence spike (owner directive
// 2026-08-21: "add a login for Yahoo Finance -- I suspect YF will work
// better with a login"). Yahoo has NO official public API and NO published
// authentication contract; `domain/market-data/yahoo-compatible.ts` (the
// production adapter) only ever calls the ANONYMOUS best-effort endpoints.
// This script is evidence-gathering ONLY -- it is not imported by, and does
// not change, any provider/adapter code.
//
// WHAT THIS PROBES
//   1. ANONYMOUS leg (always runs, needs no credentials, touches no owner
//      data): the anonymous cookie+crumb handshake community tooling uses
//      (`fc.yahoo.com` -> `/v1/test/getcrumb`), then a small, fixed set of
//      PUBLIC-ticker read endpoints (chart, search, the account-entitlement
//      endpoint, and the portfolio-read endpoint family) -- field NAMES and
//      HTTP-status evidence only, per this script's no-values rule below.
//   2. AUTHENTICATED leg (only runs if the owner has supplied login
//      cookies -- see "HOW TO SUPPLY LOGIN COOKIES" below): repeats the
//      account-entitlement and chart calls WITH the login session, so the
//      two legs' evidence can be diffed. Structurally can never reach a
//      portfolio WRITE endpoint (BRK-013A/B/C territory) -- this script only
//      ever issues GET requests, and only to the specific paths listed
//      above.
//
// THE NO-VALUES RULE (this spike touches Yahoo login-session identity, the
// closest thing this codebase has to another provider's tax data)
//   This script NEVER prints: a cookie VALUE (only cookie NAMES + expiry,
//   which Yahoo itself sends over plaintext HTTP headers and which reveal
//   nothing about the account), a crumb VALUE (only its length and whether
//   it looks like an error page -- mirrors yfinance's own detection), or
//   any account-identifying field (guid, email, display name). It DOES
//   print: HTTP status codes, response field-NAME shapes (`Object.keys`,
//   never values, same discipline as scripts/sharesight-read-spike.mjs's
//   `fieldShape`), byte counts, and a small number of already-non-secret
//   scalars this codebase already treats as safe to display to the owner
//   (a subscription TIER NAME like "free"/"gold" -- comparable to
//   `access_scope`/`quality` labels already shown in the product UI -- and
//   `exchangeDataDelayedBy`, which the production adapter already reads and
//   surfaces as `delayed_minutes`). Do not add a `console.log` anywhere in
//   this file that could print a cookie value, a crumb value, or an
//   account-identifying field.
//
// HOW TO SUPPLY LOGIN COOKIES (owner action, never done by this script)
//   Yahoo login is interactive (2FA/captcha-gated) -- there is no headless
//   grant a Cloudflare Worker could obtain on its own. The only realistic
//   path is exporting the two cookies yfinance's own current `Auth` class
//   (github.com/ranaroussi/yfinance, `yfinance/data.py`, `Auth
//   .set_login_cookies` docstring, read 2026-08-21) documents as the
//   logged-in session:
//     1. Log in to https://finance.yahoo.com in a normal browser.
//     2. Open DevTools (F12) -> Application (Chrome) / Storage (Firefox) ->
//        Cookies -> https://finance.yahoo.com.
//     3. Copy the VALUES of the cookies named exactly `T` and `Y`.
//     4. Set them as `YAHOO_COOKIE_T` / `YAHOO_COOKIE_Y`, either as process
//        environment variables or in a gitignored `.dev.vars` file at the
//        repo root (KEY=VALUE per line) -- NEVER committed, logged, or
//        pasted anywhere else. `.dev.vars`'s path can be overridden with
//        `YAHOO_DEV_VARS_PATH`.
//   NOTE ON COOKIE NAMES: MKT-009A's task brief guessed `A1`/`A3`/`A1S` (the
//   general anonymous Yahoo browser/consent cookies -- this script's own
//   anonymous leg observes and reports which of those Yahoo actually sets).
//   yfinance's current source is the authoritative correction: the LOGIN
//   cookies it accepts are named `T` and `Y` specifically, distinct from the
//   anonymous session cookie(s). See this task's evidence note in
//   docs/MARKET_DATA_STRATEGY.md for the full citation and the "verified vs
//   community-reported" breakdown.
//
// HOW TO RUN
//   node scripts/yahoo-auth-spike.mjs
//   Needs outbound network access to query1.finance.yahoo.com and
//   fc.yahoo.com (sandboxed shells must disable the network sandbox for
//   this run, same as any other live spike).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDevVars } from "./dev-vars.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const devVarsPath =
  process.env.YAHOO_DEV_VARS_PATH || join(repoRoot, ".dev.vars");
const devVars = parseDevVars(devVarsPath);

// process.env always wins over `.dev.vars`, matching this repo's other
// spike scripts (see scripts/sharesight-read-spike.mjs).
const cookieT = process.env.YAHOO_COOKIE_T || devVars.YAHOO_COOKIE_T;
const cookieY = process.env.YAHOO_COOKIE_Y || devVars.YAHOO_COOKIE_Y;

const TICKERS = ["AAPL", "BHP.AX"];
const QUERY1 = "https://query1.finance.yahoo.com";
const FC_COOKIE_URL = "https://fc.yahoo.com";
// Path confirmed live by this script's own anonymous leg -- see the run
// evidence in docs/MARKET_DATA_STRATEGY.md.
const CRUMB_URL = `${QUERY1}/v1/test/getcrumb`;
// This is the same account-entitlement endpoint yfinance's `Auth` class
// uses to determine both login state and subscription tier
// (`yfinance/data.py`'s `_SUBSCRIPTIONS_URL`, read 2026-08-21) -- a single
// lightweight JSON call, not a page scrape.
const SUBSCRIPTIONS_URL = `${QUERY1}/ws/obi-integration/v1/subscriptions`;
// Portfolio-READ endpoint family (BRK-013A pre-seed evidence only -- this
// script never calls a write verb against any portfolio path). Path taken
// from a third-party unofficial client's source
// (github.com/adriengivry/portfolyahoo, `manager.py`'s `get_portfolios`,
// read 2026-08-21), not from any Yahoo documentation (none exists).
const PORTFOLIO_READ_URL = `${QUERY1}/v7/finance/desktop/portfolio`;

/** Recursively collects field NAMES (never values), mirroring
 * scripts/sharesight-read-spike.mjs's `fieldShape`. */
function fieldShape(value, seen = new Set()) {
  if (Array.isArray(value)) {
    return value.length > 0 ? [fieldShape(value[0], seen)] : [];
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const shape = {};
    for (const key of Object.keys(value).sort()) {
      shape[key] = fieldShape(value[key], seen);
    }
    return shape;
  }
  return value === null ? "null" : typeof value;
}

/** Parses `Set-Cookie` response headers into `{ name, expiresAt }` pairs --
 * NEVER the cookie value. `expiresAt` is Yahoo's own stated expiry (or
 * `"session"` when the cookie carries no Expires/Max-Age attribute), which
 * is exactly the lifetime evidence MKT-009A needs and is not itself
 * sensitive. */
function describeSetCookies(response) {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  return raw.map((entry) => {
    const [pair, ...attrs] = entry.split(";").map((part) => part.trim());
    const name = pair.split("=")[0];
    const expiresAttr = attrs.find((attr) => /^expires=/i.test(attr.trim()));
    const expiresAt = expiresAttr
      ? expiresAttr.slice(expiresAttr.indexOf("=") + 1)
      : "session";
    return { name, expiresAt };
  });
}

/** Builds a `Cookie:` request header from `describeSetCookies`-shaped
 * evidence PLUS the original raw Set-Cookie strings kept only in-memory for
 * this one purpose (never logged) -- separated so callers that only need to
 * print evidence never touch the raw values at all. */
function cookieHeaderFrom(rawSetCookies) {
  return rawSetCookies.map((entry) => entry.split(";")[0].trim()).join("; ");
}

function section(title) {
  console.log("");
  console.log(`=== ${title} ===`);
}

/** Shared crumb-response-body classifier for BOTH the anonymous and
 * authenticated legs (F1 fix, 2026-08-21 review) -- an earlier version of
 * this script only checked the anonymous crumb response for a
 * "Too Many Requests" body, so an authenticated 429 with that same body
 * would have printed `looksLikeError=false`, wrongly implying a usable
 * crumb was returned. Never inspects/returns the crumb VALUE itself. */
function looksLikeCrumbError(text) {
  return (
    text.length === 0 || /<html>/i.test(text) || /too many requests/i.test(text)
  );
}

async function main() {
  section("ANONYMOUS LEG (no credentials, public tickers only)");

  console.log(`GET ${FC_COOKIE_URL}`);
  const fcResponse = await fetch(FC_COOKIE_URL, { redirect: "follow" });
  const rawSetCookies =
    typeof fcResponse.headers.getSetCookie === "function"
      ? fcResponse.headers.getSetCookie()
      : [];
  const cookieEvidence = describeSetCookies(fcResponse);
  console.log(
    `fc.yahoo.com: httpStatus=${fcResponse.status} cookiesSet=${cookieEvidence.length}`,
  );
  for (const { name, expiresAt } of cookieEvidence) {
    console.log(`  cookie name=${name} expiresAt=${expiresAt}`);
  }
  const anonymousCookieHeader = cookieHeaderFrom(rawSetCookies);

  console.log(`GET ${CRUMB_URL} (with anonymous cookie jar)`);
  const crumbResponse = await fetch(CRUMB_URL, {
    headers: anonymousCookieHeader
      ? { cookie: anonymousCookieHeader }
      : undefined,
  });
  const crumbText = await crumbResponse.text();
  const crumbLooksLikeError = looksLikeCrumbError(crumbText);
  console.log(
    `getcrumb: httpStatus=${crumbResponse.status} bodyBytes=${crumbText.length} looksLikeError=${crumbLooksLikeError} (crumb VALUE never printed)`,
  );
  // Deliberately not retained beyond this point: none of the endpoints
  // this spike calls below (chart, search, entitlement, portfolio-read)
  // needed a crumb, matching the production adapter's own crumb-free
  // design (see docs/MARKET_DATA_STRATEGY.md's MKT-009A section).

  for (const symbol of TICKERS) {
    const url = `${QUERY1}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    console.log(`GET ${url}`);
    const response = await fetch(url);
    const body = response.ok ? await response.json() : null;
    console.log(
      `chart ${symbol}: httpStatus=${response.status}${
        body ? "" : " (no JSON body)"
      }`,
    );
    if (body) {
      const meta = body?.chart?.result?.[0]?.meta ?? null;
      console.log(
        `chart ${symbol}: exchangeDataDelayedBy=${JSON.stringify(meta?.exchangeDataDelayedBy ?? null)} currency=${JSON.stringify(meta?.currency ?? null)}`,
      );
      console.log(`chart ${symbol}: meta field shape (names only):`);
      console.log(JSON.stringify(fieldShape(meta), null, 2));
    }
  }

  const searchUrl = `${QUERY1}/v1/finance/search?q=AAPL`;
  console.log(`GET ${searchUrl}`);
  const searchResponse = await fetch(searchUrl);
  console.log(`search: httpStatus=${searchResponse.status}`);
  if (searchResponse.ok) {
    const searchBody = await searchResponse.json();
    console.log(
      `search: first-quote field shape (names only, 0 or 1 items shown):`,
    );
    console.log(
      JSON.stringify(fieldShape(searchBody?.quotes?.[0] ?? null), null, 2),
    );
  }

  console.log(`GET ${SUBSCRIPTIONS_URL} (anonymous -- expect a denial)`);
  const anonEntitlementResponse = await fetch(SUBSCRIPTIONS_URL, {
    headers: anonymousCookieHeader
      ? { cookie: anonymousCookieHeader }
      : undefined,
  });
  console.log(
    `entitlement (anonymous): httpStatus=${anonEntitlementResponse.status} -- this is how an ABSENT/EXPIRED login is expected to signal on this endpoint`,
  );

  console.log(
    `GET ${PORTFOLIO_READ_URL} (anonymous, no crumb/userId -- BRK-013A pre-seed only)`,
  );
  const anonPortfolioResponse = await fetch(PORTFOLIO_READ_URL, {
    headers: anonymousCookieHeader
      ? { cookie: anonymousCookieHeader }
      : undefined,
  });
  console.log(
    `portfolio-read family (anonymous): httpStatus=${anonPortfolioResponse.status} -- confirms the endpoint family exists; NEVER attempted with credentials by this script`,
  );

  section("AUTHENTICATED LEG");

  if (!cookieT || !cookieY) {
    console.log(
      [
        "SKIPPED -- fails closed: no login cookies configured.",
        "",
        "Set YAHOO_COOKIE_T and YAHOO_COOKIE_Y, either:",
        "  - as process environment variables, or",
        `  - in a gitignored .dev.vars file at the repo root (${devVarsPath}),`,
        "    one KEY=VALUE per line.",
        "",
        "See this file's header comment (HOW TO SUPPLY LOGIN COOKIES) for",
        "exactly where to find these two cookies in a logged-in browser.",
        "Never commit .dev.vars, paste these values into a shared shell, or",
        "add them to a fixture. This script proceeds NO FURTHER without",
        "them -- it does not fabricate or guess an authenticated result.",
      ].join("\n"),
    );
    console.log("");
    console.log(
      "Anonymous-leg evidence above is still a complete, valid partial result.",
    );
    return;
  }

  const loginCookieHeader = `T=${cookieT}; Y=${cookieY}`;

  console.log(`GET ${CRUMB_URL} (with login cookie jar)`);
  const authCrumbResponse = await fetch(CRUMB_URL, {
    headers: { cookie: loginCookieHeader },
  });
  const authCrumbText = await authCrumbResponse.text();
  const authCrumbLooksLikeError = looksLikeCrumbError(authCrumbText);
  console.log(
    `getcrumb (authenticated): httpStatus=${authCrumbResponse.status} bodyBytes=${authCrumbText.length} looksLikeError=${authCrumbLooksLikeError} (crumb VALUE never printed)`,
  );

  console.log(`GET ${SUBSCRIPTIONS_URL} (authenticated)`);
  const entitlementResponse = await fetch(SUBSCRIPTIONS_URL, {
    headers: { cookie: loginCookieHeader },
  });
  console.log(
    `entitlement (authenticated): httpStatus=${entitlementResponse.status}`,
  );
  if (entitlementResponse.ok) {
    const entitlementBody = await entitlementResponse.json();
    const result = entitlementBody?.result ?? null;
    console.log(
      `entitlement (authenticated): loggedIn=${Boolean(result?.guid)} (guid VALUE never printed)`,
    );
    const active = Array.isArray(result?.subscriptionView)
      ? result.subscriptionView.filter((s) => s?.action === "ACTIVE")
      : [];
    console.log(
      `entitlement (authenticated): activeSubscriptionCount=${active.length}`,
    );
  } else {
    console.log(
      "entitlement (authenticated): non-2xx -- treat as NOT logged in (cookies missing/expired); the production adapter must degrade to anonymous behaviour in this case, never fabricate data (MKT-009B requirement).",
    );
  }

  const authChartUrl = `${QUERY1}/v8/finance/chart/AAPL?range=1d&interval=1d`;
  console.log(`GET ${authChartUrl} (authenticated)`);
  const authChartResponse = await fetch(authChartUrl, {
    headers: { cookie: loginCookieHeader },
  });
  console.log(
    `chart AAPL (authenticated): httpStatus=${authChartResponse.status}`,
  );
  if (authChartResponse.ok) {
    const authChartBody = await authChartResponse.json();
    const authMeta = authChartBody?.chart?.result?.[0]?.meta ?? null;
    console.log(
      `chart AAPL (authenticated): exchangeDataDelayedBy=${JSON.stringify(authMeta?.exchangeDataDelayedBy ?? null)} -- compare against the anonymous value printed above`,
    );
    console.log("chart AAPL (authenticated): meta field shape (names only):");
    console.log(JSON.stringify(fieldShape(authMeta), null, 2));
  }
}

try {
  await main();
} catch (caught) {
  // F2 fix (2026-08-21 review): an offline machine or a DNS/TLS failure
  // surfaces as an uncaught `TypeError: fetch failed` with a noisy stack
  // trace; fail closed with a readable message instead -- this is a
  // network-reachability problem, not evidence of anything Yahoo-side.
  console.error("");
  console.error(
    `Spike aborted: a network request failed unexpectedly (${caught?.message ?? caught}).`,
  );
  console.error(
    "This usually means no outbound network access to Yahoo's hosts from this machine/sandbox -- not a Yahoo-side result.",
  );
  process.exit(1);
}
