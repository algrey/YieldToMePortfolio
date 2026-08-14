import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// BRK-003: Sharesight GET-only client foundation (safety layer). All
// fixture/mock based; no live network. See AGENTS.md's Sharesight
// non-negotiable and docs/ARCHITECTURE.md's Sharesight boundary section for
// the rule these tests hold the module to.

import {
  assertSharesightTokenUrl,
  createSharesightClient,
  createSharesightTokenProvider,
  DEFAULT_SHARESIGHT_TOKEN_URL,
  SharesightBaseUrlRejectedError,
  SharesightNonGetAttemptError,
  SharesightTokenUrlRejectedError,
  sharesightGet,
  validateSharesightTokenUrlShape,
  type SharesightFetcher,
  type SharesightResult,
  type SharesightTokenProvider,
} from "../domain/sharesight/index.ts";
import {
  parseSharesightHoldings,
  parseSharesightPayouts,
  parseSharesightPortfolios,
  parseSharesightTrades,
} from "../domain/sharesight/parse.ts";

// Obviously-fake placeholder strings, never a real secret shape (mirrors
// domain/broker-sync/fixtures.ts's convention).
const FIXTURE_CLIENT_ID = "fixture-client-id-1";
const FIXTURE_CLIENT_SECRET = "fixture-client-secret-DO-NOT-USE-xyz789";
const FIXTURE_ACCESS_TOKEN = "fixture-access-token-abc123";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenFixtureResponse(accessToken = FIXTURE_ACCESS_TOKEN): Response {
  return jsonResponse(200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 1800,
  });
}

async function alwaysValidTokenProvider(): Promise<SharesightTokenProvider> {
  return {
    getAccessToken: async () => ({ ok: true, value: FIXTURE_ACCESS_TOKEN }),
  };
}

// --- 1. Headline test: structural GET-only enforcement --------------------

test("BRK-003 headline: sharesightGet has no method knob and rejects a smuggled method before ever sending", async () => {
  let called = false;
  const fetcher: SharesightFetcher = async () => {
    called = true;
    return jsonResponse(200, {});
  };
  const url = new URL("https://api.sharesight.com/api/v3/portfolios");

  // Ordinary use: no method parameter exists anywhere on the signature or
  // the init type — this is GET, always.
  const response = await sharesightGet(fetcher, url, {
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200);
  assert.equal(called, true);

  // Smuggling a method in via a type-system-bypassing cast must be rejected
  // synchronously, before fetcher is ever invoked.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    called = false;
    const smuggled = { method } as unknown as Parameters<
      typeof sharesightGet
    >[2];
    assert.throws(
      () => sharesightGet(fetcher, url, smuggled),
      SharesightNonGetAttemptError,
    );
    assert.equal(called, false, `${method} must never reach the fetcher`);
  }

  // Even a method key with an undefined/falsy value must still be rejected —
  // presence of the key, not its value, is what's checked.
  called = false;
  const undefinedMethod = { method: undefined } as unknown as Parameters<
    typeof sharesightGet
  >[2];
  assert.throws(() => sharesightGet(fetcher, url, undefinedMethod));
  assert.equal(called, false);
});

test("BRK-003 headline: the module surface exposes no generic request(method, ...) function", async () => {
  const transport = await import("../domain/sharesight/transport.ts");
  const client = await import("../domain/sharesight/client.ts");
  const barrel = await import("../domain/sharesight/index.ts");
  for (const moduleExports of [transport, client, barrel]) {
    assert.equal((moduleExports as Record<string, unknown>).request, undefined);
  }
  // sharesightGet's only request-shaping parameter is `init`, which per its
  // type has no `method` field; the function itself takes exactly 3
  // parameters (fetcher, url, init) and always sends GET.
  assert.equal(sharesightGet.length, 3);
});

// F4: strengthen the export-surface check across EVERY module in
// domain/sharesight -- not just the three above -- so a non-GET-shaped
// export could never be added anywhere in the package without failing this
// suite. `ALLOWED_NON_GET_SHAPED_EXPORTS` is deliberately empty: the
// package's one POST-capable function (`requestNewToken` in `token.ts`) is
// never exported at all (a stronger guarantee than an allowlisted
// exception), so nothing currently needs to be pinned here. If a future
// change legitimately needs to export something whose name matches the
// pattern below, it must be added to this set by its exact name, in this
// test, as a reviewed decision -- not silently.
const NON_GET_SHAPED_NAME = /post|put|patch|delete|request/i;
const ALLOWED_NON_GET_SHAPED_EXPORTS = new Set<string>();

test("BRK-003 F4: no export in any domain/sharesight module has a non-GET-shaped name", async () => {
  const modules = await Promise.all(
    [
      "../domain/sharesight/contracts.ts",
      "../domain/sharesight/transport.ts",
      "../domain/sharesight/token.ts",
      "../domain/sharesight/parse.ts",
      "../domain/sharesight/client.ts",
      "../domain/sharesight/index.ts",
    ].map((path) => import(path)),
  );
  let checkedAtLeastOneExport = false;
  for (const moduleExports of modules) {
    for (const exportName of Object.keys(moduleExports)) {
      checkedAtLeastOneExport = true;
      if (ALLOWED_NON_GET_SHAPED_EXPORTS.has(exportName)) continue;
      assert.equal(
        NON_GET_SHAPED_NAME.test(exportName),
        false,
        `export "${exportName}" has a non-GET-shaped name and is not in the reviewed allowlist`,
      );
    }
  }
  assert.ok(checkedAtLeastOneExport);
});

// F5: header denylist. Several HTTP frameworks/proxies treat one of these
// header names as "run this request as a different method" -- that must be
// rejected exactly like a smuggled `init.method`, before `fetcher` is ever
// invoked.
test("BRK-003 F5: a method-override-shaped header is rejected before sending, case-insensitively", async () => {
  const url = new URL("https://api.sharesight.com/api/v3/portfolios");
  const overrideHeaderVariants: Array<Record<string, string>> = [
    { "X-HTTP-Method-Override": "DELETE" },
    { "x-http-method-override": "delete" },
    { "X-Method-Override": "POST" },
    { _method: "PUT" },
  ];
  for (const headers of overrideHeaderVariants) {
    let called = false;
    const fetcher: SharesightFetcher = async () => {
      called = true;
      return jsonResponse(200, {});
    };
    assert.throws(
      () =>
        sharesightGet(fetcher, url, {
          headers: { accept: "application/json", ...headers },
        }),
      SharesightNonGetAttemptError,
    );
    assert.equal(called, false, JSON.stringify(headers));
  }

  // An ordinary header set (no override-shaped name) is unaffected.
  let ordinaryCalled = false;
  const ordinaryFetcher: SharesightFetcher = async () => {
    ordinaryCalled = true;
    return jsonResponse(200, {});
  };
  await sharesightGet(ordinaryFetcher, url, {
    headers: { accept: "application/json", authorization: "Bearer x" },
  });
  assert.equal(ordinaryCalled, true);
});

// --- 2. Token endpoint POST scoping -----------------------------------

test("BRK-003 token: the token POST is scoped to the configured token endpoint only", async () => {
  let calledUrl: string | null = null;
  let calledInit: RequestInit | undefined;
  const fetcher: SharesightFetcher = async (url, init) => {
    calledUrl = String(url);
    calledInit = init;
    return tokenFixtureResponse();
  };

  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    fetcher,
    now: () => 0,
  });

  const result = await provider.getAccessToken();
  assert.equal(result.ok, true);
  assert.equal(calledUrl, DEFAULT_SHARESIGHT_TOKEN_URL);
  assert.equal(calledInit?.method, "POST");
  assert.ok(String(calledInit?.body).includes("grant_type=client_credentials"));
  assert.ok(String(calledInit?.body).includes(FIXTURE_CLIENT_ID));
});

test("BRK-003 token: a configured non-default token URL is honored exactly", async () => {
  const alternateUrl = "https://portfolio.sharesight.com/oauth2/token";
  let calledUrl: string | null = null;
  const fetcher: SharesightFetcher = async (url) => {
    calledUrl = String(url);
    return tokenFixtureResponse();
  };
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    tokenUrl: alternateUrl,
    fetcher,
    now: () => 0,
  });
  const result = await provider.getAccessToken();
  assert.equal(result.ok, true);
  assert.equal(calledUrl, alternateUrl);
});

test("BRK-003 token: a redirected/altered URL is rejected before sending (secondary consistency pin)", () => {
  const configured = new URL(DEFAULT_SHARESIGHT_TOKEN_URL);
  const altered = new URL("https://evil.example.com/oauth2/token");
  assert.throws(
    () => assertSharesightTokenUrl(altered, configured),
    SharesightTokenUrlRejectedError,
  );
  // The pinned/matching case never throws.
  assert.doesNotThrow(() => assertSharesightTokenUrl(configured, configured));
});

// B1: the real safety control. A bare URL-equality pin
// (`assertSharesightTokenUrl` above, previously called with the SAME
// captured value on both sides) could never reject a misconfigured
// `tokenUrl` -- a review demonstrated credentials could be POSTed straight
// to a Sharesight DATA endpoint via config alone. `validateSharesightTokenUrlShape`
// / `createSharesightTokenProvider` must reject that, synchronously, before
// the provider (and therefore its fetcher) even exists.
test("BRK-003 B1: a data-API-shaped tokenUrl is rejected at provider creation, with zero fetch calls", () => {
  let fetchCalled = false;
  const fetcher: SharesightFetcher = async () => {
    fetchCalled = true;
    return jsonResponse(200, { id: "1" });
  };

  assert.throws(
    () =>
      createSharesightTokenProvider({
        clientId: FIXTURE_CLIENT_ID,
        clientSecret: FIXTURE_CLIENT_SECRET,
        // The reviewer's exact proof-of-concept: this is Sharesight's real
        // data API shape, not a token endpoint.
        tokenUrl: "https://api.sharesight.com/api/v3/portfolios/1",
        fetcher,
        now: () => 0,
      }),
    SharesightTokenUrlRejectedError,
  );
  assert.equal(fetchCalled, false);

  // Direct unit coverage of the underlying validator, independent of the
  // factory, for the same data-API-shaped URL plus a URL that is
  // https/token-pathed but simply doesn't look like an OAuth endpoint.
  assert.throws(
    () =>
      validateSharesightTokenUrlShape(
        new URL("https://api.sharesight.com/api/v3/portfolios/1"),
      ),
    SharesightTokenUrlRejectedError,
  );
  assert.throws(
    () =>
      validateSharesightTokenUrlShape(
        new URL("https://api.sharesight.com/some/other/path"),
      ),
    SharesightTokenUrlRejectedError,
  );
  // The default/expected shape passes.
  assert.doesNotThrow(() =>
    validateSharesightTokenUrlShape(new URL(DEFAULT_SHARESIGHT_TOKEN_URL)),
  );
});

// B2: plaintext http would send client credentials in cleartext. Only a
// loopback host may use http (reserved for future local mock tooling); any
// other host must be rejected before sending, at provider creation.
test("BRK-003 B2: a non-loopback http tokenUrl is rejected at provider creation, with zero fetch calls; a loopback http tokenUrl is permitted", () => {
  let fetchCalled = false;
  const fetcher: SharesightFetcher = async () => {
    fetchCalled = true;
    return tokenFixtureResponse();
  };

  assert.throws(
    () =>
      createSharesightTokenProvider({
        clientId: FIXTURE_CLIENT_ID,
        clientSecret: FIXTURE_CLIENT_SECRET,
        tokenUrl: "http://api.sharesight.com/oauth2/token",
        fetcher,
        now: () => 0,
      }),
    SharesightTokenUrlRejectedError,
  );
  assert.equal(fetchCalled, false);

  // A loopback host is the sole documented http exception, for a future
  // local mock server in BRK-008 spike tooling -- construction must not
  // throw, and a real request must be allowed to proceed.
  assert.doesNotThrow(() =>
    createSharesightTokenProvider({
      clientId: FIXTURE_CLIENT_ID,
      clientSecret: FIXTURE_CLIENT_SECRET,
      tokenUrl: "http://127.0.0.1:4010/oauth2/token",
      fetcher,
      now: () => 0,
    }),
  );
});

// F8: pin the token endpoint's host to sharesight.com (or a subdomain).
// The owner's Sharesight access path now uses their MAIN PAID account
// credentials (no account-level write barrier), so this app-layer host pin
// is one of the few remaining defenses against a misconfigured or
// attacker-influenced tokenUrl exfiltrating client credentials.
test("BRK-003 F8: a tokenUrl on a host that is not sharesight.com (or a subdomain) is rejected, including confusable hosts", () => {
  const rejectedUrls = [
    // Unrelated host entirely.
    "https://evil.example.com/oauth2/token",
    // Same suffix as a SUBSTRING but not a real subdomain -- a naive
    // `endsWith("sharesight.com")` check would wrongly accept this.
    "https://xsharesight.com/oauth2/token",
    // Starts with Sharesight's domain but is actually a subdomain of
    // evil.com -- a naive prefix check would wrongly accept this.
    "https://api.sharesight.com.evil.com/oauth2/token",
  ];
  for (const url of rejectedUrls) {
    assert.throws(
      () => validateSharesightTokenUrlShape(new URL(url)),
      SharesightTokenUrlRejectedError,
      url,
    );
    let fetchCalled = false;
    assert.throws(
      () =>
        createSharesightTokenProvider({
          clientId: FIXTURE_CLIENT_ID,
          clientSecret: FIXTURE_CLIENT_SECRET,
          tokenUrl: url,
          fetcher: async () => {
            fetchCalled = true;
            return tokenFixtureResponse();
          },
          now: () => 0,
        }),
      SharesightTokenUrlRejectedError,
      url,
    );
    assert.equal(fetchCalled, false, url);
  }

  // A real Sharesight subdomain passes.
  assert.doesNotThrow(() =>
    validateSharesightTokenUrlShape(
      new URL("https://portfolio.sharesight.com/oauth2/token"),
    ),
  );

  // Loopback still needs no override flag (unaffected by the host pin --
  // it's the documented local-mock-only exception).
  assert.doesNotThrow(() =>
    validateSharesightTokenUrlShape(
      new URL("http://127.0.0.1:4010/oauth2/token"),
    ),
  );

  // The explicit opt-in, mirroring the data client's unsafeAllowOtherHost,
  // permits an otherwise-rejected host.
  assert.doesNotThrow(() =>
    validateSharesightTokenUrlShape(
      new URL("https://mock.example.test/oauth2/token"),
      { unsafeAllowOtherHost: true },
    ),
  );
  assert.doesNotThrow(() =>
    createSharesightTokenProvider({
      clientId: FIXTURE_CLIENT_ID,
      clientSecret: FIXTURE_CLIENT_SECRET,
      tokenUrl: "https://mock.example.test/oauth2/token",
      unsafeAllowOtherHost: true,
      fetcher: async () => tokenFixtureResponse(),
      now: () => 0,
    }),
  );
});

// F9: canonicalize (lowercase + percent-decode) the path before EITHER
// path-shape check reads it, so an uppercase or percent-encoded variant of
// the data-API path can't evade the `/api/` rejection.
test("BRK-003 F9: uppercase and percent-encoded /api/ path variants are rejected; a malformed escape rejects cleanly", () => {
  assert.throws(
    () =>
      validateSharesightTokenUrlShape(
        new URL("https://api.sharesight.com/API/v3/portfolios/1"),
      ),
    SharesightTokenUrlRejectedError,
  );
  assert.throws(
    () =>
      validateSharesightTokenUrlShape(
        new URL("https://api.sharesight.com/api%2Fv3/portfolios/1"),
      ),
    SharesightTokenUrlRejectedError,
  );
  // A malformed percent-escape must reject (typed error), never throw an
  // uncaught decode exception.
  assert.throws(
    () =>
      validateSharesightTokenUrlShape(
        new URL("https://api.sharesight.com/oauth2/token%"),
      ),
    SharesightTokenUrlRejectedError,
  );
  // An uppercase-but-otherwise-fine oauth path still passes.
  assert.doesNotThrow(() =>
    validateSharesightTokenUrlShape(
      new URL("https://api.sharesight.com/OAuth2/Token"),
    ),
  );
});

// F10: a URL carrying userinfo (username/password) is rejected at
// creation, in both the token module and the data client.
test("BRK-003 F10: a tokenUrl or baseUrl carrying userinfo is rejected at creation in both modules", async () => {
  assert.throws(
    () =>
      validateSharesightTokenUrlShape(
        new URL("https://user:pass@api.sharesight.com/oauth2/token"),
      ),
    SharesightTokenUrlRejectedError,
  );
  let tokenFetchCalled = false;
  assert.throws(
    () =>
      createSharesightTokenProvider({
        clientId: FIXTURE_CLIENT_ID,
        clientSecret: FIXTURE_CLIENT_SECRET,
        tokenUrl: "https://user:pass@api.sharesight.com/oauth2/token",
        fetcher: async () => {
          tokenFetchCalled = true;
          return tokenFixtureResponse();
        },
        now: () => 0,
      }),
    SharesightTokenUrlRejectedError,
  );
  assert.equal(tokenFetchCalled, false);

  let dataFetchCalled = false;
  const tokenProvider = await alwaysValidTokenProvider();
  assert.throws(
    () =>
      createSharesightClient({
        baseUrl: "https://user:pass@api.sharesight.com/api/v3",
        tokenProvider,
        fetcher: async () => {
          dataFetchCalled = true;
          return jsonResponse(200, { portfolios: [] });
        },
      }),
    SharesightBaseUrlRejectedError,
  );
  assert.equal(dataFetchCalled, false);
});

test("BRK-003 token: a 3xx redirect response from the token endpoint is treated as invalid, not followed", async () => {
  let calledCount = 0;
  const fetcher: SharesightFetcher = async () => {
    calledCount += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.example.com/oauth2/token" },
    });
  };
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    fetcher,
    now: () => 0,
  });
  const result = await provider.getAccessToken();
  assert.equal(result.ok, false);
  assert.equal(calledCount, 1); // never retried to a second, redirected URL
});

// --- 3. Token refresh with the injected clock ---------------------------

test("BRK-003 token refresh: caches within the leeway window and refreshes strictly before expiry", async () => {
  let clock = 0;
  let callCount = 0;
  const fetcher: SharesightFetcher = async () => {
    callCount += 1;
    return tokenFixtureResponse(`fixture-access-token-${callCount}`);
  };
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    fetcher,
    now: () => clock,
  });

  const first = await provider.getAccessToken();
  assert.equal(first.ok, true);
  assert.equal(callCount, 1);

  clock += 1_000; // 1s later — well within the 1800s expiry
  const second = await provider.getAccessToken();
  assert.equal(callCount, 1); // still cached, no refresh
  assert.deepEqual(second, first);

  clock += 1800 * 1000; // now past expiry (and past the refresh leeway)
  const third = await provider.getAccessToken();
  assert.equal(callCount, 2); // refreshed
  assert.notDeepEqual(third, first);
});

test("BRK-003 token refresh: refresh failure yields a typed unavailable result, and a data call never attempts a request", async () => {
  let dataFetchCalled = false;
  const tokenFetcher: SharesightFetcher = async () =>
    jsonResponse(401, { error: "invalid_client" });
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    fetcher: tokenFetcher,
    now: () => 0,
  });

  const dataFetcher: SharesightFetcher = async () => {
    dataFetchCalled = true;
    return jsonResponse(200, { portfolios: [] });
  };
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: dataFetcher,
  });

  const result = await client.listPortfolios();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "authentication");
  }
  assert.equal(dataFetchCalled, false);
});

test("BRK-003 client: refresh failure from any token error kind is propagated and never attempts the data GET", async () => {
  let dataFetchCalled = false;
  const failingProvider: SharesightTokenProvider = {
    getAccessToken: async () => ({
      ok: false,
      error: {
        kind: "timeout",
        message: "token request timed out",
        retryable: true,
      },
    }),
  };
  const client = createSharesightClient({
    tokenProvider: failingProvider,
    fetcher: async () => {
      dataFetchCalled = true;
      return jsonResponse(200, { portfolios: [] });
    },
  });
  const result = await client.getPortfolioHoldings("p1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "timeout");
  assert.equal(dataFetchCalled, false);
});

// F6: pin the data client's baseUrl host. A misconfigured baseUrl must not
// be able to ship the Bearer token to an arbitrary host.
test("BRK-003 F6: a non-api.sharesight.com baseUrl is rejected at client creation, with zero fetch calls", async () => {
  let fetchCalled = false;
  const fetcher: SharesightFetcher = async () => {
    fetchCalled = true;
    return jsonResponse(200, { portfolios: [] });
  };
  const tokenProvider = await alwaysValidTokenProvider();

  assert.throws(
    () =>
      createSharesightClient({
        baseUrl: "https://evil.example.com/api/v3",
        tokenProvider,
        fetcher,
      }),
    SharesightBaseUrlRejectedError,
  );
  assert.equal(fetchCalled, false);
});

test("BRK-003 F6: unsafeAllowOtherHost explicitly overrides the host pin (BRK-008 spike tooling only)", async () => {
  let calledUrl: string | null = null;
  const fetcher: SharesightFetcher = async (url) => {
    calledUrl = String(url);
    return jsonResponse(200, { portfolios: [] });
  };
  const tokenProvider = await alwaysValidTokenProvider();

  const client = createSharesightClient({
    baseUrl: "https://mock.example.test/api/v3",
    unsafeAllowOtherHost: true,
    tokenProvider,
    fetcher,
  });
  const result = await client.listPortfolios();
  assert.equal(result.ok, true);
  assert.equal(typeof calledUrl, "string");
  assert.ok(String(calledUrl).startsWith("https://mock.example.test/"));
});

test("BRK-003 F6: the default baseUrl (api.sharesight.com) needs no override flag", async () => {
  const tokenProvider = await alwaysValidTokenProvider();
  assert.doesNotThrow(() =>
    createSharesightClient({
      tokenProvider,
      fetcher: async () => jsonResponse(200, { portfolios: [] }),
    }),
  );
});

// F7: the `non_get_rejected` error kind must actually be produced by the
// client's error path, not left dead -- and a structural GET-only
// rejection must never be folded into "timeout".
test("BRK-003 F7: a SharesightNonGetAttemptError reaching the client's request path maps to kind non_get_rejected, never timeout", async () => {
  const tokenProvider = await alwaysValidTokenProvider();
  const client = createSharesightClient({
    tokenProvider,
    // Simulates a structural GET-only rejection surfacing from the request
    // path (e.g. transport.ts's header-override/method-smuggling guard).
    fetcher: async () => {
      throw new SharesightNonGetAttemptError("simulated structural rejection");
    },
  });
  const result = await client.listPortfolios();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "non_get_rejected");
    assert.equal(result.error.retryable, false);
    assert.notEqual(result.error.kind, "timeout");
  }
});

// --- 4. Endpoint parsing: fixtures, malformed states, decimal exactness --

// All fixture payloads below are synthetic v3-shaped test data invented for
// this suite, not captured real Sharesight responses (BRK-008 will confirm
// live shapes).

const PORTFOLIOS_FIXTURE = {
  portfolios: [
    { id: "port_1", name: "Guest Share (Synthetic)", currency: "AUD" },
  ],
};

const HOLDINGS_FIXTURE = {
  holdings: [
    {
      instrument: { code: "IXJ", market: "ASX", currency: "AUD" },
      quantity: 100,
      average_cost: "12.34",
      market_value: 1500.5,
    },
  ],
};

const TRADES_FIXTURE = {
  trades: [
    {
      id: "trade_1",
      instrument: { code: "WHC", market: "ASX", currency: "AUD" },
      transaction_type: "BUY",
      transaction_date: "2026-01-15",
      quantity: 50,
      price: "5.20",
      brokerage: 9.95,
    },
  ],
};

const PAYOUTS_FIXTURE = {
  payouts: [
    {
      id: "payout_1",
      instrument: { code: "IXJ", market: "ASX", currency: "AUD" },
      paid_on: "2026-02-01",
      amount: "120.00",
      franked_amount: "84.00",
      unfranked_amount: "36.00",
      resident_withholding_tax: "0.00",
    },
  ],
};

function clientWithFixtureBody(body: unknown, status = 200) {
  return createSharesightClient({
    tokenProvider: {
      getAccessToken: async () => ({ ok: true, value: FIXTURE_ACCESS_TOKEN }),
    },
    fetcher: async () => jsonResponse(status, body),
  });
}

test("BRK-003 parsing: valid fixtures parse into typed results with exact decimal strings", async () => {
  const portfolios =
    await clientWithFixtureBody(PORTFOLIOS_FIXTURE).listPortfolios();
  assert.equal(portfolios.ok, true);
  if (portfolios.ok) {
    assert.equal(portfolios.value.length, 1);
    assert.equal(portfolios.value[0]?.id, "port_1");
    assert.equal(portfolios.value[0]?.currencyCode, "AUD");
  }

  const holdings =
    await clientWithFixtureBody(HOLDINGS_FIXTURE).getPortfolioHoldings(
      "port_1",
    );
  assert.equal(holdings.ok, true);
  if (holdings.ok) {
    const holding = holdings.value[0];
    assert.equal(holding?.quantityDecimal, "100");
    assert.equal(holding?.averageCostDecimal, "12.34");
    assert.equal(holding?.marketValueDecimal, "1500.5");
    assert.equal(holding?.instrumentCode, "IXJ");
    assert.equal(holding?.portfolioId, "port_1");
  }

  const trades =
    await clientWithFixtureBody(TRADES_FIXTURE).listTrades("port_1");
  assert.equal(trades.ok, true);
  if (trades.ok) {
    const trade = trades.value[0];
    assert.equal(trade?.transactionType, "buy");
    assert.equal(trade?.quantityDecimal, "50");
    assert.equal(trade?.priceDecimal, "5.20");
    assert.equal(trade?.brokerageDecimal, "9.95");
  }

  const payouts =
    await clientWithFixtureBody(PAYOUTS_FIXTURE).listPayouts("port_1");
  assert.equal(payouts.ok, true);
  if (payouts.ok) {
    const payout = payouts.value[0];
    assert.equal(payout?.amountDecimal, "120.00");
    assert.equal(payout?.frankedAmountDecimal, "84.00");
    assert.equal(payout?.unfrankedAmountDecimal, "36.00");
    assert.equal(payout?.taxWithheldDecimal, "0.00");
  }
});

// F1: an optional money field that is genuinely ABSENT is an honest
// "unknown" (null); the SAME field PRESENT but unparseable (e.g. a corrupt
// franking figure) must fail the whole item closed, never be silently
// collapsed to the same null "unknown" state -- franked/unfranked/withheld
// amounts feed downstream tax assumptions, so a silent null there would be
// worse than an explicit failure.
test("BRK-003 F1: an absent optional decimal is an honest null; a present-but-malformed one fails the item closed", async () => {
  const holdingsAbsentOptional = {
    holdings: [
      {
        instrument: { code: "IXJ", market: "ASX", currency: "AUD" },
        quantity: 100,
        // average_cost / market_value genuinely absent.
      },
    ],
  };
  const absentResult = await clientWithFixtureBody(
    holdingsAbsentOptional,
  ).getPortfolioHoldings("port_1");
  assert.equal(absentResult.ok, true);
  if (absentResult.ok) {
    assert.equal(absentResult.value[0]?.averageCostDecimal, null);
    assert.equal(absentResult.value[0]?.marketValueDecimal, null);
  }

  const holdingsMalformedOptional = {
    holdings: [
      {
        instrument: { code: "IXJ", market: "ASX", currency: "AUD" },
        quantity: 100,
        average_cost: "N/A", // present, but not a decimal
      },
    ],
  };
  const malformedResult = await clientWithFixtureBody(
    holdingsMalformedOptional,
  ).getPortfolioHoldings("port_1");
  assert.equal(malformedResult.ok, false);
  if (!malformedResult.ok) {
    assert.equal(malformedResult.error.kind, "invalid_response");
  }

  // Same distinction for payouts' tax-relevant optional fields.
  const payoutsMalformedFranked = {
    payouts: [
      {
        id: "payout_2",
        instrument: { code: "IXJ", market: "ASX", currency: "AUD" },
        paid_on: "2026-02-01",
        amount: "50.00",
        franked_amount: "not-a-number", // present, corrupt -- must not silently become "unknown"
      },
    ],
  };
  const payoutsMalformedResult = await clientWithFixtureBody(
    payoutsMalformedFranked,
  ).listPayouts("port_1");
  assert.equal(payoutsMalformedResult.ok, false);
  if (!payoutsMalformedResult.ok) {
    assert.equal(payoutsMalformedResult.error.kind, "invalid_response");
  }

  const payoutsAbsentFranked = {
    payouts: [
      {
        id: "payout_3",
        instrument: { code: "IXJ", market: "ASX", currency: "AUD" },
        paid_on: "2026-02-01",
        amount: "50.00",
        // franked_amount / unfranked_amount / resident_withholding_tax
        // genuinely absent.
      },
    ],
  };
  const payoutsAbsentResult =
    await clientWithFixtureBody(payoutsAbsentFranked).listPayouts("port_1");
  assert.equal(payoutsAbsentResult.ok, true);
  if (payoutsAbsentResult.ok) {
    assert.equal(payoutsAbsentResult.value[0]?.frankedAmountDecimal, null);
    assert.equal(payoutsAbsentResult.value[0]?.unfrankedAmountDecimal, null);
    assert.equal(payoutsAbsentResult.value[0]?.taxWithheldDecimal, null);
  }
});

test("BRK-003 parsing: missing/malformed envelopes and fields produce a typed invalid_response, never a guessed value", async () => {
  const cases: Array<[string, () => Promise<SharesightResult<unknown>>]> = [
    [
      "portfolios missing envelope",
      () => clientWithFixtureBody({}).listPortfolios(),
    ],
    [
      "portfolio missing currency",
      () =>
        clientWithFixtureBody({
          portfolios: [{ id: "p1", name: "X" }],
        }).listPortfolios(),
    ],
    [
      "holdings missing instrument",
      () =>
        clientWithFixtureBody({
          holdings: [{ quantity: 1 }],
        }).getPortfolioHoldings("p1"),
    ],
    [
      "holdings malformed quantity",
      () =>
        clientWithFixtureBody({
          holdings: [
            {
              instrument: { code: "IXJ", currency: "AUD" },
              quantity: "not-a-number",
            },
          ],
        }).getPortfolioHoldings("p1"),
    ],
    [
      "trades invalid transaction_type",
      () =>
        clientWithFixtureBody({
          trades: [
            {
              id: "t1",
              instrument: { code: "WHC", currency: "AUD" },
              transaction_type: "TRANSFER",
              transaction_date: "2026-01-15",
              quantity: 1,
              price: 1,
            },
          ],
        }).listTrades("p1"),
    ],
    [
      "payouts missing amount",
      () =>
        clientWithFixtureBody({
          payouts: [
            {
              id: "pay1",
              instrument: { code: "IXJ", currency: "AUD" },
              paid_on: "2026-02-01",
            },
          ],
        }).listPayouts("p1"),
    ],
  ];

  for (const [label, run] of cases) {
    const result = await run();
    assert.equal(result.ok, false, label);
    if (!result.ok) {
      assert.equal(result.error.kind, "invalid_response", label);
    }
  }
});

test("BRK-003 parsing: parse functions directly reject a non-object root and a non-array envelope", () => {
  assert.equal(parseSharesightPortfolios(null).ok, false);
  assert.equal(
    parseSharesightPortfolios({ portfolios: "not-an-array" }).ok,
    false,
  );
  assert.equal(parseSharesightHoldings({ holdings: null }, "p1").ok, false);
  assert.equal(parseSharesightTrades(42, "p1").ok, false);
  assert.equal(parseSharesightPayouts(undefined, "p1").ok, false);
});

// --- 5. No secrets/tokens/payloads in any thrown or returned value --------

test("BRK-003 secrets discipline: the fixture client secret and access token never appear in any thrown/returned value", async () => {
  const serialized: string[] = [];
  function capture(value: unknown): void {
    serialized.push(
      JSON.stringify(value, (_key, v) =>
        v instanceof Error ? { name: v.name, message: v.message } : v,
      ),
    );
  }

  // Auth failure (bad credentials).
  const authFailureProvider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    fetcher: async () =>
      jsonResponse(401, {
        error: "invalid_client",
        error_description: FIXTURE_CLIENT_SECRET,
      }),
    now: () => 0,
  });
  capture(await authFailureProvider.getAccessToken());

  // Malformed token JSON.
  const malformedTokenProvider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    fetcher: async () => new Response("not-json", { status: 200 }),
    now: () => 0,
  });
  capture(await malformedTokenProvider.getAccessToken());

  // Data-level 500 and malformed-JSON errors, plus evidence capture.
  const evidenceLog: unknown[] = [];
  const workingProvider = await alwaysValidTokenProvider();
  const client500 = createSharesightClient({
    tokenProvider: workingProvider,
    fetcher: async () => jsonResponse(500, { message: "boom" }),
  });
  capture(await client500.listPortfolios());

  const clientMalformed = createSharesightClient({
    tokenProvider: workingProvider,
    fetcher: async () => new Response("<not json>", { status: 200 }),
  });
  capture(await clientMalformed.listPortfolios());

  const clientWithEvidence = createSharesightClient({
    tokenProvider: workingProvider,
    fetcher: async () => jsonResponse(200, PORTFOLIOS_FIXTURE),
    onFetchEvidence: (evidence) => evidenceLog.push(evidence),
  });
  capture(await clientWithEvidence.listPortfolios());
  for (const evidence of evidenceLog) capture(evidence);

  // Smuggled-method rejection error.
  try {
    sharesightGet(
      workingProvider as unknown as SharesightFetcher, // never actually called
      new URL("https://api.sharesight.com/api/v3/portfolios"),
      { method: "POST" } as unknown as Parameters<typeof sharesightGet>[2],
    );
  } catch (caught) {
    capture(caught);
  }

  assert.ok(serialized.length > 0);
  for (const value of serialized) {
    assert.equal(value.includes(FIXTURE_CLIENT_SECRET), false, value);
    assert.equal(value.includes(FIXTURE_ACCESS_TOKEN), false, value);
  }
  // Evidence entries carry only a hash + timestamp, never the raw body.
  for (const evidence of evidenceLog) {
    const keys = Object.keys(evidence as Record<string, unknown>).sort();
    assert.deepEqual(keys, ["ingestedAt", "payloadSha256"]);
    assert.equal(
      JSON.stringify(evidence).includes(
        JSON.stringify(PORTFOLIOS_FIXTURE).slice(1, 20),
      ),
      false,
    );
  }
});

// --- 6. Non-2xx, timeout, and 401-after-expiry paths -----------------

test("BRK-003 transport errors: non-2xx statuses map to typed, correctly-retryable kinds", async () => {
  const provider = await alwaysValidTokenProvider();
  const statusCases: Array<[number, string, boolean]> = [
    [401, "authentication", false],
    [403, "entitlement", false],
    [429, "rate_limit", false],
    [500, "transient_upstream", true],
    [503, "transient_upstream", true],
    [404, "invalid_response", false],
  ];
  for (const [status, expectedKind, expectedRetryable] of statusCases) {
    const client = createSharesightClient({
      tokenProvider: provider,
      fetcher: async () => jsonResponse(status, {}),
    });
    const result = await client.listPortfolios();
    assert.equal(result.ok, false, String(status));
    if (!result.ok) {
      assert.equal(result.error.kind, expectedKind, String(status));
      assert.equal(result.error.retryable, expectedRetryable, String(status));
    }
  }
});

test("BRK-003 transport errors: a request that never resolves in time yields a typed, retryable timeout", async () => {
  const provider = await alwaysValidTokenProvider();
  const client = createSharesightClient({
    tokenProvider: provider,
    timeoutMs: 15,
    fetcher: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(jsonResponse(200, PORTFOLIOS_FIXTURE)), 250);
      }),
  });
  const result = await client.listPortfolios();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "timeout");
    assert.equal(result.error.retryable, true);
  }
});

test("BRK-003 transport errors: 401 arriving after a cached token was believed valid surfaces as a typed authentication error", async () => {
  // Simulates the token provider's local cache being stale relative to the
  // server (e.g. a server-side revocation) rather than a client-side clock
  // problem — the data call itself must still fail closed with a typed,
  // non-retryable result rather than silently returning partial/empty data.
  const provider = await alwaysValidTokenProvider();
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(401, { error: "token_expired" }),
  });
  const result = await client.getPortfolioHoldings("p1");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "authentication");
    assert.equal(result.error.retryable, false);
  }
});

// --- Nothing reaches client bundles ---------------------------------------

test("BRK-003: domain/sharesight has no client-bundle exposure (no 'use client', no app/ imports)", async () => {
  const dir = fileURLToPath(new URL("../domain/sharesight/", import.meta.url));
  const entries = await readdir(dir);
  const sourceFiles = entries.filter((entry) => entry.endsWith(".ts"));
  assert.ok(sourceFiles.length > 0);
  for (const file of sourceFiles) {
    const contents = await readFile(`${dir}${file}`, "utf-8");
    // Only the client-directive pragma form matters here (a literal
    // mention of the phrase in prose/comments, like this test's own
    // description, is not a directive).
    assert.equal(/^\s*["']use client["'];?\s*$/m.test(contents), false, file);
    assert.equal(/from\s+["']\.\.\/\.\.\/app\//.test(contents), false, file);
    assert.equal(/from\s+["']app\//.test(contents), false, file);
  }
});
