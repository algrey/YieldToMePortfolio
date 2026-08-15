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
  SHARESIGHT_OOB_REDIRECT_URI,
  SharesightBaseUrlRejectedError,
  SharesightRedirectUriRejectedError,
  SharesightTokenGrantConfigError,
  SharesightTokenUrlRejectedError,
  validateSharesightRedirectUri,
  validateSharesightTokenUrlShape,
  type SharesightFetcher,
  type SharesightResult,
  type SharesightTokenProvider,
} from "../domain/sharesight/index.ts";
// `sharesightGet` and `SharesightNonGetAttemptError` are the raw,
// package-internal transport primitive (BRK-003 follow-up: sealed out of
// `domain/sharesight/index.ts`'s barrel so the typed client is the only
// public way to reach Sharesight). Tests are not the public surface, so
// importing them directly from `transport.ts` here is fine and is how these
// smuggling tests exercise the primitive itself.
import {
  SharesightNonGetAttemptError,
  sharesightGet,
} from "../domain/sharesight/transport.ts";
import {
  parseSharesightHoldings,
  parseSharesightPayouts,
  parseSharesightPortfolios,
  parseSharesightTrades,
} from "../domain/sharesight/parse.ts";
// BRK-008: the grant-selection/fallback strategy is a pure module,
// deliberately NOT re-exported from the barrel (see its own header comment)
// -- it never reaches Sharesight itself. Importing it directly here mirrors
// how the spike script itself imports it.
import {
  decideInitialGrant,
  isGrantRejection,
  shouldFallBackToAuthorizationCode,
} from "../domain/sharesight/token-strategy.ts";

// Obviously-fake placeholder strings, never a real secret shape (mirrors
// domain/broker-sync/fixtures.ts's convention).
const FIXTURE_CLIENT_ID = "fixture-client-id-1";
const FIXTURE_CLIENT_SECRET = "fixture-client-secret-DO-NOT-USE-xyz789";
const FIXTURE_ACCESS_TOKEN = "fixture-access-token-abc123";
// BRK-008 fixtures for the authorization_code / refresh_token grants.
const FIXTURE_AUTH_CODE = "fixture-one-time-code-DO-NOT-USE";
const FIXTURE_REFRESH_TOKEN = "fixture-refresh-token-DO-NOT-USE-qrs456";

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

/** BRK-008: like `tokenFixtureResponse`, but optionally including a
 * `refresh_token` field, since that's the whole point of these grants. */
function tokenFixtureResponseWithRefresh(
  accessToken: string,
  refreshToken: string | null,
): Response {
  return jsonResponse(200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 1800,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
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

// BRK-003 follow-up: the barrel (`domain/sharesight/index.ts`) must expose
// no way to reach Sharesight except through the typed client. Previously
// the barrel re-exported `sharesightGet` itself -- the raw GET-only
// transport primitive, which takes a caller-controlled `URL` with no host
// pin of its own (the host pin lives in `client.ts`, not `transport.ts`) --
// so a direct caller with a hand-built Authorization header could aim it at
// an arbitrary host and leak a token. That export has been removed; this
// pins the barrel's ENTIRE export-name set exactly, so any future addition
// (re-adding `sharesightGet`, or adding some new URL-accepting primitive)
// must edit this assertion as a conscious, reviewed decision rather than
// slipping through silently. Of the names below, `assertSharesightTokenUrl`
// and `validateSharesightTokenUrlShape` do accept a `URL` argument, but
// both are pure shape/equality validators that never call `fetch` --
// `createSharesightClient` and `createSharesightTokenProvider` remain the
// only barrel exports that can actually send a Sharesight request.
const EXPECTED_BARREL_EXPORT_NAMES = [
  "DEFAULT_SHARESIGHT_TOKEN_URL",
  "SHARESIGHT_OOB_REDIRECT_URI",
  "SharesightBaseUrlRejectedError",
  "SharesightRedirectUriRejectedError",
  "SharesightTokenGrantConfigError",
  "SharesightTokenUrlRejectedError",
  "assertSharesightTokenUrl",
  "createSharesightClient",
  "createSharesightTokenProvider",
  "deriveShapeEvidence",
  "parseSharesightHoldings",
  "parseSharesightPayouts",
  "parseSharesightPortfolios",
  "parseSharesightTrades",
  "validateSharesightRedirectUri",
  "validateSharesightTokenUrlShape",
].sort();

test("BRK-003 follow-up: the barrel's export-name set is pinned exactly, and sharesightGet is not among them", async () => {
  const barrel = await import("../domain/sharesight/index.ts");
  assert.deepEqual(Object.keys(barrel).sort(), EXPECTED_BARREL_EXPORT_NAMES);
  assert.equal(
    (barrel as Record<string, unknown>).sharesightGet,
    undefined,
    "sharesightGet must not be reachable through the barrel",
  );
  assert.equal(
    (barrel as Record<string, unknown>).SharesightNonGetAttemptError,
    undefined,
    "SharesightNonGetAttemptError is package-internal, not part of the barrel's public surface",
  );
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
      "../domain/sharesight/token-strategy.ts",
      "../domain/sharesight/parse.ts",
      "../domain/sharesight/client.ts",
      "../domain/sharesight/shape-evidence.ts",
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

// BRK-004 review: a leading/doubled/trailing dot produces an empty hostname
// label (e.g. `.sharesight.com`). The string still ENDS WITH
// `.sharesight.com`, so a bare `endsWith` check (F8's fix) wrongly accepted
// it -- these must be rejected outright.
test("BRK-004: a tokenUrl host with an empty label (leading/doubled/trailing dot) is rejected even though it ends with .sharesight.com", () => {
  const rejectedUrls = [
    "https://.sharesight.com/oauth2/token",
    "https://api..sharesight.com/oauth2/token",
    "https://sharesight.com./oauth2/token",
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

// --- 2b. BRK-008: authorization_code / refresh_token grants --------------

test("BRK-008: authorization_code grant sends exactly the expected form fields to the validated token URL, and nowhere else", async () => {
  let calledUrl: string | null = null;
  let calledInit: RequestInit | undefined;
  const fetcher: SharesightFetcher = async (url, init) => {
    calledUrl = String(url);
    calledInit = init;
    return tokenFixtureResponseWithRefresh(
      FIXTURE_ACCESS_TOKEN,
      FIXTURE_REFRESH_TOKEN,
    );
  };
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "authorization_code",
    code: FIXTURE_AUTH_CODE,
    redirectUri: SHARESIGHT_OOB_REDIRECT_URI,
    fetcher,
    now: () => 0,
  });

  const result = await provider.getAccessToken();
  assert.equal(result.ok, true);
  // Same pinned token URL as every other grant -- BRK-003's shape/host
  // validation applies unconditionally, regardless of grant.
  assert.equal(calledUrl, DEFAULT_SHARESIGHT_TOKEN_URL);
  assert.equal(calledInit?.method, "POST");
  const sentParams = new URLSearchParams(String(calledInit?.body));
  assert.deepEqual([...sentParams.keys()].sort(), [
    "client_id",
    "client_secret",
    "code",
    "grant_type",
    "redirect_uri",
  ]);
  assert.equal(sentParams.get("grant_type"), "authorization_code");
  assert.equal(sentParams.get("code"), FIXTURE_AUTH_CODE);
  assert.equal(sentParams.get("redirect_uri"), SHARESIGHT_OOB_REDIRECT_URI);
  assert.equal(sentParams.get("client_id"), FIXTURE_CLIENT_ID);
  assert.equal(sentParams.get("client_secret"), FIXTURE_CLIENT_SECRET);
});

test("BRK-008: refresh_token grant sends exactly the expected form fields, and rotates the refresh token via onRefreshTokenRotated", async () => {
  let clock = 0;
  let callCount = 0;
  const sentBodies: string[] = [];
  const fetcher: SharesightFetcher = async (_url, init) => {
    callCount += 1;
    sentBodies.push(String(init?.body));
    return tokenFixtureResponseWithRefresh(
      `fixture-access-token-${callCount}`,
      `fixture-refresh-token-${callCount}`,
    );
  };
  const rotated: string[] = [];
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "refresh_token",
    refreshToken: "fixture-initial-refresh-token",
    onRefreshTokenRotated: (token) => rotated.push(token),
    fetcher,
    now: () => clock,
  });

  const first = await provider.getAccessToken();
  assert.equal(first.ok, true);
  assert.equal(callCount, 1);
  const firstParams = new URLSearchParams(sentBodies[0]);
  assert.deepEqual([...firstParams.keys()].sort(), [
    "client_id",
    "client_secret",
    "grant_type",
    "refresh_token",
  ]);
  assert.equal(firstParams.get("grant_type"), "refresh_token");
  assert.equal(
    firstParams.get("refresh_token"),
    "fixture-initial-refresh-token",
  );
  assert.deepEqual(rotated, ["fixture-refresh-token-1"]);

  clock += 1800 * 1000; // past expiry -> refreshes again
  const second = await provider.getAccessToken();
  assert.equal(second.ok, true);
  assert.equal(callCount, 2);
  const secondParams = new URLSearchParams(sentBodies[1]);
  // The SECOND request uses the ROTATED refresh token from the first
  // response, never the original one supplied at construction.
  assert.equal(secondParams.get("refresh_token"), "fixture-refresh-token-1");
  assert.deepEqual(rotated, [
    "fixture-refresh-token-1",
    "fixture-refresh-token-2",
  ]);
});

test("BRK-008: authorization_code is used for exactly the first exchange, then transitions to refresh_token", async () => {
  let clock = 0;
  let callCount = 0;
  const sentBodies: string[] = [];
  const fetcher: SharesightFetcher = async (_url, init) => {
    callCount += 1;
    sentBodies.push(String(init?.body));
    return tokenFixtureResponseWithRefresh(
      `fixture-access-token-${callCount}`,
      FIXTURE_REFRESH_TOKEN,
    );
  };
  const rotated: string[] = [];
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "authorization_code",
    code: FIXTURE_AUTH_CODE,
    redirectUri: SHARESIGHT_OOB_REDIRECT_URI,
    onRefreshTokenRotated: (token) => rotated.push(token),
    fetcher,
    now: () => clock,
  });

  await provider.getAccessToken();
  assert.equal(callCount, 1);
  assert.equal(
    new URLSearchParams(sentBodies[0]).get("grant_type"),
    "authorization_code",
  );
  assert.deepEqual(rotated, [FIXTURE_REFRESH_TOKEN]);

  clock += 1800 * 1000;
  await provider.getAccessToken();
  assert.equal(callCount, 2);
  const secondParams = new URLSearchParams(sentBodies[1]);
  assert.equal(secondParams.get("grant_type"), "refresh_token");
  assert.equal(secondParams.get("refresh_token"), FIXTURE_REFRESH_TOKEN);
  // The one-time code must never be resent.
  assert.equal(secondParams.has("code"), false);
});

test("BRK-008: an authorization_code exchange that returns no refresh_token leaves the provider unable to refresh again, without resending the code", async () => {
  let clock = 0;
  let callCount = 0;
  const fetcher: SharesightFetcher = async () => {
    callCount += 1;
    return tokenFixtureResponseWithRefresh(FIXTURE_ACCESS_TOKEN, null);
  };
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "authorization_code",
    code: FIXTURE_AUTH_CODE,
    redirectUri: SHARESIGHT_OOB_REDIRECT_URI,
    fetcher,
    now: () => clock,
  });

  const first = await provider.getAccessToken();
  assert.equal(first.ok, true);
  assert.equal(callCount, 1);

  clock += 1800 * 1000; // past expiry -> a second call attempts a refresh
  const second = await provider.getAccessToken();
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.kind, "authentication");
    assert.equal(second.error.retryable, false);
  }
  assert.equal(callCount, 1); // never resent the already-consumed code
});

test("BRK-008: concurrent getAccessToken() calls racing a refresh_token rotation invoke onRefreshTokenRotated exactly once", async () => {
  let callCount = 0;
  const fetcher: SharesightFetcher = async () => {
    callCount += 1;
    return tokenFixtureResponseWithRefresh(
      FIXTURE_ACCESS_TOKEN,
      "fixture-rotated-once",
    );
  };
  const rotated: string[] = [];
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "refresh_token",
    refreshToken: "fixture-initial-refresh-token",
    onRefreshTokenRotated: (token) => rotated.push(token),
    fetcher,
    now: () => 0,
  });

  const [a, b, c] = await Promise.all([
    provider.getAccessToken(),
    provider.getAccessToken(),
    provider.getAccessToken(),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, true);
  assert.equal(callCount, 1); // deduped into one in-flight request
  assert.deepEqual(rotated, ["fixture-rotated-once"]);
});

test("BRK-008 B1 regression: client_credentials never transitions grants even when a response carries a refresh_token, and onRefreshTokenRotated is never fired", async () => {
  let clock = 0;
  let callCount = 0;
  const sentBodies: string[] = [];
  const fetcher: SharesightFetcher = async (_url, init) => {
    callCount += 1;
    sentBodies.push(String(init?.body));
    // Response includes a refresh_token even though this is a
    // client_credentials exchange -- an unusual but not impossible shape,
    // and the exact case the review's B1 finding probed.
    return tokenFixtureResponseWithRefresh(
      `fixture-access-token-${callCount}`,
      FIXTURE_REFRESH_TOKEN,
    );
  };
  let callbackFired = false;
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "client_credentials",
    onRefreshTokenRotated: () => {
      callbackFired = true;
    },
    fetcher,
    now: () => clock,
  });

  const first = await provider.getAccessToken();
  assert.equal(first.ok, true);
  assert.equal(callCount, 1);
  assert.equal(
    new URLSearchParams(sentBodies[0]).get("grant_type"),
    "client_credentials",
  );

  clock += 1800 * 1000; // past expiry -> a second request
  const second = await provider.getAccessToken();
  assert.equal(second.ok, true);
  assert.equal(callCount, 2);
  // The SECOND request must still use client_credentials -- it must never
  // have silently drifted to refresh_token merely because the FIRST
  // response happened to carry one.
  const secondParams = new URLSearchParams(sentBodies[1]);
  assert.equal(secondParams.get("grant_type"), "client_credentials");
  assert.equal(secondParams.has("refresh_token"), false);
  assert.equal(
    callbackFired,
    false,
    "onRefreshTokenRotated must never fire for client_credentials",
  );
});

test("BRK-008 F1: a throwing onRefreshTokenRotated callback never fails getAccessToken() or discards the just-issued token", async () => {
  const fetcher: SharesightFetcher = async () =>
    tokenFixtureResponseWithRefresh(
      FIXTURE_ACCESS_TOKEN,
      FIXTURE_REFRESH_TOKEN,
    );
  const provider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "refresh_token",
    refreshToken: "fixture-initial-refresh-token",
    onRefreshTokenRotated: () => {
      throw new Error("simulated persistence failure");
    },
    fetcher,
    now: () => 0,
  });

  const result = await provider.getAccessToken();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, FIXTURE_ACCESS_TOKEN);
  }
});

test("BRK-008 F2: an unknown grantType string is rejected at provider creation, with zero fetch calls", () => {
  let fetchCalled = false;
  assert.throws(
    () =>
      createSharesightTokenProvider({
        clientId: FIXTURE_CLIENT_ID,
        clientSecret: FIXTURE_CLIENT_SECRET,
        // Bypasses the type system -- simulates a plain-JS caller (e.g. one
        // of this repo's own .mjs scripts, which have no type backstop)
        // passing a typo'd or unsupported grant string.
        grantType: "device_code" as unknown as "client_credentials",
        fetcher: async () => {
          fetchCalled = true;
          return tokenFixtureResponse();
        },
        now: () => 0,
      }),
    SharesightTokenGrantConfigError,
  );
  assert.equal(fetchCalled, false);
});

test("BRK-008: redirect_uri validation accepts the OOB literal and https URLs; rejects other strings, non-https, and userinfo", () => {
  assert.doesNotThrow(() =>
    validateSharesightRedirectUri(SHARESIGHT_OOB_REDIRECT_URI),
  );
  assert.doesNotThrow(() =>
    validateSharesightRedirectUri("https://example.com/callback"),
  );

  assert.throws(
    () => validateSharesightRedirectUri("not-a-url-and-not-the-oob-literal"),
    SharesightRedirectUriRejectedError,
  );
  assert.throws(
    // A near-miss of the OOB literal is not accepted -- exact match only.
    () => validateSharesightRedirectUri("urn:ietf:wg:oauth:2.0:oobx"),
    SharesightRedirectUriRejectedError,
  );
  assert.throws(
    () => validateSharesightRedirectUri("http://example.com/callback"),
    SharesightRedirectUriRejectedError,
  );
  assert.throws(
    () =>
      validateSharesightRedirectUri("https://user:pass@example.com/callback"),
    SharesightRedirectUriRejectedError,
  );

  let fetchCalled = false;
  assert.throws(
    () =>
      createSharesightTokenProvider({
        clientId: FIXTURE_CLIENT_ID,
        clientSecret: FIXTURE_CLIENT_SECRET,
        grantType: "authorization_code",
        code: FIXTURE_AUTH_CODE,
        redirectUri: "not-a-url-and-not-the-oob-literal",
        fetcher: async () => {
          fetchCalled = true;
          return tokenFixtureResponse();
        },
        now: () => 0,
      }),
    SharesightRedirectUriRejectedError,
  );
  assert.equal(fetchCalled, false);
});

test("BRK-008: each grant's missing required option is rejected at provider creation, with zero fetch calls", () => {
  const cases: Array<[string, () => unknown]> = [
    [
      "authorization_code missing code",
      () =>
        createSharesightTokenProvider({
          clientId: FIXTURE_CLIENT_ID,
          clientSecret: FIXTURE_CLIENT_SECRET,
          grantType: "authorization_code",
          redirectUri: SHARESIGHT_OOB_REDIRECT_URI,
          fetcher: async () => tokenFixtureResponse(),
          now: () => 0,
        }),
    ],
    [
      "authorization_code missing redirectUri",
      () =>
        createSharesightTokenProvider({
          clientId: FIXTURE_CLIENT_ID,
          clientSecret: FIXTURE_CLIENT_SECRET,
          grantType: "authorization_code",
          code: FIXTURE_AUTH_CODE,
          fetcher: async () => tokenFixtureResponse(),
          now: () => 0,
        }),
    ],
    [
      "authorization_code empty (whitespace-only) code",
      () =>
        createSharesightTokenProvider({
          clientId: FIXTURE_CLIENT_ID,
          clientSecret: FIXTURE_CLIENT_SECRET,
          grantType: "authorization_code",
          code: "   ",
          redirectUri: SHARESIGHT_OOB_REDIRECT_URI,
          fetcher: async () => tokenFixtureResponse(),
          now: () => 0,
        }),
    ],
    [
      "refresh_token missing refreshToken",
      () =>
        createSharesightTokenProvider({
          clientId: FIXTURE_CLIENT_ID,
          clientSecret: FIXTURE_CLIENT_SECRET,
          grantType: "refresh_token",
          fetcher: async () => tokenFixtureResponse(),
          now: () => 0,
        }),
    ],
  ];

  for (const [label, run] of cases) {
    assert.throws(run, SharesightTokenGrantConfigError, label);
  }

  // client_credentials needs none of the above -- unaffected.
  assert.doesNotThrow(() =>
    createSharesightTokenProvider({
      clientId: FIXTURE_CLIENT_ID,
      clientSecret: FIXTURE_CLIENT_SECRET,
      grantType: "client_credentials",
      fetcher: async () => tokenFixtureResponse(),
      now: () => 0,
    }),
  );
});

test("BRK-008: decideInitialGrant / isGrantRejection / shouldFallBackToAuthorizationCode strategy", () => {
  assert.equal(
    decideInitialGrant({ hasRefreshToken: true, hasAuthCode: false }),
    "refresh_token",
  );
  assert.equal(
    decideInitialGrant({ hasRefreshToken: false, hasAuthCode: true }),
    "client_credentials",
  );
  assert.equal(
    decideInitialGrant({ hasRefreshToken: false, hasAuthCode: false }),
    "client_credentials",
  );

  assert.equal(
    isGrantRejection({
      kind: "authentication",
      message: "x",
      retryable: false,
    }),
    true,
  );
  // A retryable variant is a network/availability problem, never a grant
  // rejection, even sharing the same "authentication" kind.
  assert.equal(
    isGrantRejection({ kind: "authentication", message: "x", retryable: true }),
    false,
  );
  const otherKinds = [
    "timeout",
    "rate_limit",
    "transient_upstream",
    "invalid_response",
    "entitlement",
    "non_get_rejected",
  ] as const;
  for (const kind of otherKinds) {
    assert.equal(
      isGrantRejection({ kind, message: "x", retryable: false }),
      false,
      kind,
    );
  }

  const rejection = {
    kind: "authentication",
    message: "x",
    retryable: false,
  } as const;
  assert.equal(shouldFallBackToAuthorizationCode(rejection, true), true);
  // No code configured -- nothing to fall back TO.
  assert.equal(shouldFallBackToAuthorizationCode(rejection, false), false);
  // A retryable/network error must never trigger a fallback, even with a
  // code configured -- retrying the SAME grant (or surfacing the error) is
  // correct there, not spending a one-time code on a flaky connection.
  const timeoutError = {
    kind: "timeout",
    message: "x",
    retryable: true,
  } as const;
  assert.equal(shouldFallBackToAuthorizationCode(timeoutError, true), false);
});

// BRK-008 refinement: `token.ts`'s bounded oauthErrorCode diagnostic lets
// `shouldFallBackToAuthorizationCode` distinguish two grant-rejection
// shapes that previously looked identical (same `kind`/`retryable`) --
// `invalid_client` (the CLIENT itself was rejected; authorization_code
// would send the identical client_id/client_secret and fail the same way,
// so falling back would only burn the one-time code for nothing) from
// `unsupported_grant_type` (the textbook "client_credentials genuinely
// isn't enabled" signal the fallback exists for) and every other
// grant-rejection shape (still falls back, unchanged from the original
// behavior).
test("BRK-008 strategy refinement: invalid_client skips the authorization_code fallback; unsupported_grant_type (and an unknown/absent code) still falls back", () => {
  const invalidClient = {
    kind: "authentication",
    message: "x",
    retryable: false,
    oauthErrorCode: "invalid_client",
  } as const;
  assert.equal(
    shouldFallBackToAuthorizationCode(invalidClient, true),
    false,
    "invalid_client must never fall back, even with a code configured",
  );

  const unsupportedGrantType = {
    kind: "authentication",
    message: "x",
    retryable: false,
    oauthErrorCode: "unsupported_grant_type",
  } as const;
  assert.equal(
    shouldFallBackToAuthorizationCode(unsupportedGrantType, true),
    true,
    "unsupported_grant_type is the precise, textbook fallback trigger",
  );

  // A genuine grant-rejection with no oauthErrorCode (diagnostic couldn't
  // identify one -- unknown code, non-JSON body, etc.) is unaffected by
  // this refinement: it still falls back exactly as before BRK-008 added
  // the diagnostic.
  const noCodeIdentified = {
    kind: "authentication",
    message: "x",
    retryable: false,
  } as const;
  assert.equal(shouldFallBackToAuthorizationCode(noCodeIdentified, true), true);

  // invalid_client with no code configured is still false for the
  // pre-existing "nothing to fall back to" reason, not the new refinement.
  assert.equal(shouldFallBackToAuthorizationCode(invalidClient, false), false);
});

// --- 2c. BRK-008: OAuth error-code diagnostic on a non-2xx token response -

test("BRK-008 diagnostic: every allowlisted token-endpoint error code surfaces as oauthErrorCode, with a static failure message", async () => {
  const allowlistedCodes = [
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "access_denied",
  ] as const;
  for (const code of allowlistedCodes) {
    const provider = createSharesightTokenProvider({
      clientId: FIXTURE_CLIENT_ID,
      clientSecret: FIXTURE_CLIENT_SECRET,
      fetcher: async () =>
        jsonResponse(400, {
          error: code,
          error_description: "must never be read or surfaced",
        }),
      now: () => 0,
    });
    const result = await provider.getAccessToken();
    assert.equal(result.ok, false, code);
    if (!result.ok) {
      assert.equal(result.error.oauthErrorCode, code, code);
      assert.equal(
        result.error.message,
        "Sharesight token request was not accepted.",
        code,
      );
    }
  }
});

test("BRK-008 diagnostic: an unrecognized code, a missing body, a non-JSON body, and an oversized body all yield no oauthErrorCode, and never throw", async () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    [
      "unrecognized error code (not in the closed allowlist)",
      async () => jsonResponse(400, { error: "some_custom_extension_code" }),
    ],
    [
      "error field present but not a string",
      async () => jsonResponse(400, { error: 12345 }),
    ],
    ["no body at all", async () => new Response(null, { status: 500 })],
    [
      "non-JSON body",
      async () =>
        new Response("<html>Sharesight is down</html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      // The `error` field is well-formed and near the start of the body,
      // but a >4KB body must still be truncated before JSON.parse ever
      // runs -- the truncation itself breaks the JSON (unterminated
      // string/object), so this fails exactly like ordinary malformed
      // JSON: no throw, no oauthErrorCode.
      "oversized body (>4KB) truncated mid-value",
      async () =>
        jsonResponse(400, {
          error: "invalid_grant",
          padding: "A".repeat(10_000),
        }),
    ],
  ];

  for (const [label, fetcherResponse] of cases) {
    const provider = createSharesightTokenProvider({
      clientId: FIXTURE_CLIENT_ID,
      clientSecret: FIXTURE_CLIENT_SECRET,
      fetcher: fetcherResponse,
      now: () => 0,
    });
    const result = await provider.getAccessToken();
    assert.equal(result.ok, false, label);
    if (!result.ok) {
      assert.equal(result.error.oauthErrorCode, undefined, label);
    }
  }
});

test("BRK-008 secrets discipline: authorization code, redirect_uri, and refresh tokens never appear in any thrown/returned value", async () => {
  const serialized: string[] = [];
  function capture(value: unknown): void {
    serialized.push(
      JSON.stringify(value, (_key, v) =>
        v instanceof Error ? { name: v.name, message: v.message } : v,
      ),
    );
  }

  // A redirect_uri validation failure must not echo the candidate value
  // (which, here, happens to also be the fixture auth code) in its message.
  try {
    createSharesightTokenProvider({
      clientId: FIXTURE_CLIENT_ID,
      clientSecret: FIXTURE_CLIENT_SECRET,
      grantType: "authorization_code",
      code: FIXTURE_AUTH_CODE,
      redirectUri: FIXTURE_AUTH_CODE, // not a URL, not the OOB literal
      fetcher: async () => tokenFixtureResponse(),
      now: () => 0,
    });
  } catch (caught) {
    capture(caught);
  }

  // A token endpoint that (unexpectedly) echoes the auth code back in an
  // error body must not leak it through this module's typed result --
  // BRK-008's bounded diagnostic reads this body (unlike before), but only
  // ever extracts the allowlisted `error` code, never `error_description`.
  const authCodeFailureProvider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "authorization_code",
    code: FIXTURE_AUTH_CODE,
    redirectUri: SHARESIGHT_OOB_REDIRECT_URI,
    fetcher: async () =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: `code ${FIXTURE_AUTH_CODE} already used`,
      }),
    now: () => 0,
  });
  const authCodeFailureResult = await authCodeFailureProvider.getAccessToken();
  capture(authCodeFailureResult);
  assert.equal(
    !authCodeFailureResult.ok && authCodeFailureResult.error.oauthErrorCode,
    "invalid_grant",
  );

  // Same for a refresh_token failure echoing the refresh token itself.
  const refreshFailureProvider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "refresh_token",
    refreshToken: FIXTURE_REFRESH_TOKEN,
    fetcher: async () =>
      jsonResponse(401, {
        error: "invalid_grant",
        error_description: FIXTURE_REFRESH_TOKEN,
      }),
    now: () => 0,
  });
  const refreshFailureResult = await refreshFailureProvider.getAccessToken();
  capture(refreshFailureResult);
  assert.equal(
    !refreshFailureResult.ok && refreshFailureResult.error.oauthErrorCode,
    "invalid_grant",
  );

  // A rotated refresh token is intentionally handed to
  // `onRefreshTokenRotated` -- the ONE documented channel for the caller to
  // persist it; that is not a leak. It must never additionally appear in
  // the getAccessToken() result itself, though.
  let rotatedViaCallback: string | null = null;
  const rotatingProvider = createSharesightTokenProvider({
    clientId: FIXTURE_CLIENT_ID,
    clientSecret: FIXTURE_CLIENT_SECRET,
    grantType: "refresh_token",
    refreshToken: "fixture-starting-refresh-token",
    onRefreshTokenRotated: (token) => {
      rotatedViaCallback = token;
    },
    fetcher: async () =>
      tokenFixtureResponseWithRefresh(
        FIXTURE_ACCESS_TOKEN,
        FIXTURE_REFRESH_TOKEN,
      ),
    now: () => 0,
  });
  capture(await rotatingProvider.getAccessToken());
  assert.equal(rotatedViaCallback, FIXTURE_REFRESH_TOKEN);

  assert.ok(serialized.length > 0);
  for (const value of serialized) {
    assert.equal(value.includes(FIXTURE_AUTH_CODE), false, value);
    assert.equal(value.includes(FIXTURE_REFRESH_TOKEN), false, value);
    assert.equal(
      value.includes("fixture-starting-refresh-token"),
      false,
      value,
    );
  }
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

// Matches live shape evidence 2026-08-15 (owner's real account, see
// docs/ARCHITECTURE.md §8.2): a `listPortfolios` envelope item -- numeric
// `id`, `currency_code` (not `currency`), plus the optional fields this
// contract models. Extra live fields this contract does not model
// (`consolidated`, `trader`, `user_id`, etc.) are included to prove they are
// ignored for forward-compatibility rather than rejected.
const PORTFOLIOS_FIXTURE = {
  portfolios: [
    {
      id: 4213579,
      name: "Guest Share (Synthetic)",
      currency_code: "AUD",
      access_level: "owner",
      consolidated: false,
      country_code: "AU",
      cg_discount: "0.5",
      default_sale_allocation_method: "average_cost",
      disable_automatic_transactions: false,
      external_identifier: null,
      financial_year_end: "30/06",
      holding_id: null,
      inception_date: "2020-01-01",
      interest_method: "simple",
      owner_name: "Test Owner (Synthetic)",
      payout_sync_cash_account_id: null,
      rwtr_rate: 0,
      tax_entity_type: "individual",
      trader: false,
      trade_sync_cash_account_id: null,
      tz_name: "Australia/Sydney",
      user_id: 998877,
    },
  ],
};

// Matches live shape evidence 2026-08-15 (owner's real account, see
// docs/ARCHITECTURE.md §8.2): `instrument.market_code`/`instrument.
// currency_code` (not `market`/`currency`), a numeric holding `id`, and a
// top-level `symbol` field. `quantity` is included here only to prove the
// OPTIONAL-when-present path still works -- the confirmed live
// HoldingPortfolioList response carries no quantity/value field at all.
const HOLDINGS_FIXTURE = {
  holdings: [
    {
      id: 9001,
      symbol: "IXJ",
      instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
      quantity: 100,
      average_cost: "12.34",
      market_value: 1500.5,
    },
  ],
};

// Matches live shape evidence 2026-08-15: numeric trade `id`, `holding_id`/
// `portfolio_id` (numeric, integrity-checked but never trusted over the
// caller-supplied portfolioId), `unique_identifier`, `value`,
// `brokerage_currency_code`, `exchange_rate`(_pair), `state`, `paid_on`,
// `description_code`, `source_category` -- and `transaction_type`, which is
// OPTIONAL per that same evidence (a live item can omit it entirely).
const TRADES_FIXTURE = {
  trades: [
    {
      id: 5001,
      unique_identifier: "abc-123",
      instrument: { code: "WHC", market_code: "ASX", currency_code: "AUD" },
      transaction_type: "BUY",
      transaction_date: "2026-01-15",
      quantity: 50,
      price: "5.20",
      value: 260,
      brokerage: 9.95,
      brokerage_currency_code: "AUD",
      exchange_rate: 1,
      exchange_rate_pair: "AUD/AUD",
      holding_id: 4001,
      portfolio_id: 3001,
      state: "confirmed",
      paid_on: null,
      description_code: "buy",
      source_category: "trade",
    },
  ],
};

const PAYOUTS_FIXTURE = {
  payouts: [
    {
      id: "payout_1",
      instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
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
    // Numeric 4213579 stringifies exactly -- the resolved BRK-008 id shape.
    assert.equal(portfolios.value[0]?.id, "4213579");
    assert.equal(portfolios.value[0]?.currencyCode, "AUD");
    assert.equal(portfolios.value[0]?.name, "Guest Share (Synthetic)");
    assert.equal(portfolios.value[0]?.tzName, "Australia/Sydney");
    assert.equal(portfolios.value[0]?.cgDiscount, "0.5");
    assert.equal(portfolios.value[0]?.inceptionDate, "2020-01-01");
    assert.equal(portfolios.value[0]?.accessLevel, "owner");
    assert.equal(portfolios.value[0]?.financialYearEnd, "30/06");
    assert.equal(portfolios.value[0]?.countryCode, "AU");
    assert.equal(portfolios.value[0]?.ownerName, "Test Owner (Synthetic)");
    assert.equal(portfolios.value[0]?.taxEntityType, "individual");
  }

  const holdings =
    await clientWithFixtureBody(HOLDINGS_FIXTURE).getPortfolioHoldings(
      "port_1",
    );
  assert.equal(holdings.ok, true);
  if (holdings.ok) {
    const holding = holdings.value[0];
    assert.equal(holding?.id, "9001");
    assert.equal(holding?.symbol, "IXJ");
    assert.equal(holding?.quantityDecimal, "100");
    assert.equal(holding?.averageCostDecimal, "12.34");
    assert.equal(holding?.marketValueDecimal, "1500.5");
    assert.equal(holding?.instrumentCode, "IXJ");
    assert.equal(holding?.marketCode, "ASX");
    assert.equal(holding?.currencyCode, "AUD");
    assert.equal(holding?.portfolioId, "port_1");
  }

  const trades = await clientWithFixtureBody(TRADES_FIXTURE).listTrades("3001");
  assert.equal(trades.ok, true);
  if (trades.ok) {
    const trade = trades.value[0];
    assert.equal(trade?.id, "5001");
    assert.equal(trade?.uniqueIdentifier, "abc-123");
    assert.equal(trade?.holdingId, "4001");
    // The trade's OWN portfolio_id (3001) is cross-checked against the
    // caller-supplied portfolioId this fetch was scoped to ("3001") -- they
    // must agree or the item fails closed (mismatch case tested below).
    assert.equal(trade?.portfolioId, "3001");
    assert.equal(trade?.transactionType, "buy");
    assert.equal(trade?.quantityDecimal, "50");
    assert.equal(trade?.priceDecimal, "5.20");
    assert.equal(trade?.valueDecimal, "260");
    assert.equal(trade?.brokerageDecimal, "9.95");
    assert.equal(trade?.brokerageCurrencyCode, "AUD");
    assert.equal(trade?.exchangeRateDecimal, "1");
    assert.equal(trade?.exchangeRatePair, "AUD/AUD");
    assert.equal(trade?.state, "confirmed");
    assert.equal(trade?.paidOnDate, null);
    assert.equal(trade?.descriptionCode, "buy");
    assert.equal(trade?.sourceCategory, "trade");
    assert.equal(trade?.instrumentCode, "WHC");
    assert.equal(trade?.marketCode, "ASX");
    assert.equal(trade?.currencyCode, "AUD");
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
        id: 9002,
        symbol: "IXJ",
        instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
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

  // Live-confirmed 2026-08-15: quantity itself is genuinely absent from the
  // real HoldingPortfolioList response -- an honest null, not a failure.
  const holdingsQuantityAbsent = {
    holdings: [
      {
        id: 9004,
        symbol: "IXJ",
        instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
        // quantity genuinely absent.
      },
    ],
  };
  const quantityAbsentResult = await clientWithFixtureBody(
    holdingsQuantityAbsent,
  ).getPortfolioHoldings("port_1");
  assert.equal(quantityAbsentResult.ok, true);
  if (quantityAbsentResult.ok) {
    assert.equal(quantityAbsentResult.value[0]?.quantityDecimal, null);
  }

  const holdingsMalformedOptional = {
    holdings: [
      {
        id: 9003,
        symbol: "IXJ",
        instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
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
        instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
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
        instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
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

// BRK-008 decision (2026-08-15, docs/ARCHITECTURE.md §8.2): money/quantity
// numbers are converted via an exact double round-trip; exponential
// notation (a magnitude too large/small for `String()` to render as a
// plain decimal) is REJECTED, fail-closed, rather than reformatted --
// reformatting would fabricate a representation Sharesight never sent.
test("BRK-008: a money/quantity field whose numeric magnitude would render in exponential notation fails the item closed", async () => {
  const priceExponential = await clientWithFixtureBody({
    trades: [
      {
        id: 1,
        instrument: { code: "WHC", market_code: "ASX", currency_code: "AUD" },
        transaction_date: "2026-01-15",
        quantity: 1,
        price: 1e21, // renders as "1e+21" -- not a valid decimal string
        holding_id: 1,
        portfolio_id: 1,
      },
    ],
  }).listTrades("1");
  assert.equal(priceExponential.ok, false);
  if (!priceExponential.ok) {
    assert.equal(priceExponential.error.kind, "invalid_response");
  }

  // The same rejection applies to an OPTIONAL decimal field, never silently
  // collapsing to "unknown" (absent-vs-malformed discipline).
  const averageCostExponential = await clientWithFixtureBody({
    holdings: [
      {
        id: 1,
        symbol: "IXJ",
        instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
        average_cost: 1e-21,
      },
    ],
  }).getPortfolioHoldings("p1");
  assert.equal(averageCostExponential.ok, false);
  if (!averageCostExponential.ok) {
    assert.equal(averageCostExponential.error.kind, "invalid_response");
  }

  // An ordinary, non-exponential large/small magnitude still parses exactly.
  const ordinaryMagnitude = await clientWithFixtureBody({
    trades: [
      {
        id: 1,
        instrument: { code: "WHC", market_code: "ASX", currency_code: "AUD" },
        transaction_date: "2026-01-15",
        quantity: 1,
        price: 0.0001,
        holding_id: 1,
        portfolio_id: 1,
      },
    ],
  }).listTrades("1");
  assert.equal(ordinaryMagnitude.ok, true);
  if (ordinaryMagnitude.ok) {
    assert.equal(ordinaryMagnitude.value[0]?.priceDecimal, "0.0001");
  }
});

test("BRK-003 parsing: missing/malformed envelopes and fields produce a typed invalid_response, never a guessed value", async () => {
  const cases: Array<[string, () => Promise<SharesightResult<unknown>>]> = [
    [
      "portfolios missing envelope",
      () => clientWithFixtureBody({}).listPortfolios(),
    ],
    [
      "portfolio missing currency_code",
      () =>
        clientWithFixtureBody({
          portfolios: [{ id: 1, name: "X" }],
        }).listPortfolios(),
    ],
    [
      "portfolio string id (rejected -- id must be a numeric integer)",
      () =>
        clientWithFixtureBody({
          portfolios: [{ id: "1", name: "X", currency_code: "AUD" }],
        }).listPortfolios(),
    ],
    [
      "portfolio non-integer id",
      () =>
        clientWithFixtureBody({
          portfolios: [{ id: 1.5, name: "X", currency_code: "AUD" }],
        }).listPortfolios(),
    ],
    [
      "portfolio negative id",
      () =>
        clientWithFixtureBody({
          portfolios: [{ id: -1, name: "X", currency_code: "AUD" }],
        }).listPortfolios(),
    ],
    [
      "portfolio id beyond Number.MAX_SAFE_INTEGER",
      () =>
        clientWithFixtureBody({
          portfolios: [
            {
              id: Number.MAX_SAFE_INTEGER + 2,
              name: "X",
              currency_code: "AUD",
            },
          ],
        }).listPortfolios(),
    ],
    [
      "portfolio lowercase currency_code (not ISO 4217-shaped)",
      () =>
        clientWithFixtureBody({
          portfolios: [{ id: 1, name: "X", currency_code: "aud" }],
        }).listPortfolios(),
    ],
    [
      "portfolio wrong-type optional field (tz_name) fails the item closed",
      () =>
        clientWithFixtureBody({
          portfolios: [{ id: 1, name: "X", currency_code: "AUD", tz_name: 42 }],
        }).listPortfolios(),
    ],
    [
      "holdings missing instrument",
      () =>
        clientWithFixtureBody({
          holdings: [{ id: 1, symbol: "IXJ", quantity: 1 }],
        }).getPortfolioHoldings("p1"),
    ],
    [
      "holdings missing id",
      () =>
        clientWithFixtureBody({
          holdings: [
            {
              symbol: "IXJ",
              instrument: {
                code: "IXJ",
                market_code: "ASX",
                currency_code: "AUD",
              },
            },
          ],
        }).getPortfolioHoldings("p1"),
    ],
    [
      "holdings missing symbol",
      () =>
        clientWithFixtureBody({
          holdings: [
            {
              id: 1,
              instrument: {
                code: "IXJ",
                market_code: "ASX",
                currency_code: "AUD",
              },
            },
          ],
        }).getPortfolioHoldings("p1"),
    ],
    [
      "holdings instrument missing market_code",
      () =>
        clientWithFixtureBody({
          holdings: [
            {
              id: 1,
              symbol: "IXJ",
              instrument: { code: "IXJ", currency_code: "AUD" },
            },
          ],
        }).getPortfolioHoldings("p1"),
    ],
    [
      "holdings malformed quantity",
      () =>
        clientWithFixtureBody({
          holdings: [
            {
              id: 1,
              symbol: "IXJ",
              instrument: {
                code: "IXJ",
                market_code: "ASX",
                currency_code: "AUD",
              },
              quantity: "not-a-number",
            },
          ],
        }).getPortfolioHoldings("p1"),
    ],
    [
      "trades missing id",
      () =>
        clientWithFixtureBody({
          trades: [
            {
              instrument: {
                code: "WHC",
                market_code: "ASX",
                currency_code: "AUD",
              },
              transaction_date: "2026-01-15",
              quantity: 1,
              price: 1,
              holding_id: 1,
              portfolio_id: 1,
            },
          ],
        }).listTrades("1"),
    ],
    [
      "trades string id (rejected -- id must be a numeric integer)",
      () =>
        clientWithFixtureBody({
          trades: [
            {
              id: "t1",
              instrument: {
                code: "WHC",
                market_code: "ASX",
                currency_code: "AUD",
              },
              transaction_date: "2026-01-15",
              quantity: 1,
              price: 1,
              holding_id: 1,
              portfolio_id: 1,
            },
          ],
        }).listTrades("1"),
    ],
    [
      "trades missing holding_id",
      () =>
        clientWithFixtureBody({
          trades: [
            {
              id: 1,
              instrument: {
                code: "WHC",
                market_code: "ASX",
                currency_code: "AUD",
              },
              transaction_date: "2026-01-15",
              quantity: 1,
              price: 1,
              portfolio_id: 1,
            },
          ],
        }).listTrades("1"),
    ],
    [
      "trades missing portfolio_id",
      () =>
        clientWithFixtureBody({
          trades: [
            {
              id: 1,
              instrument: {
                code: "WHC",
                market_code: "ASX",
                currency_code: "AUD",
              },
              transaction_date: "2026-01-15",
              quantity: 1,
              price: 1,
              holding_id: 1,
            },
          ],
        }).listTrades("1"),
    ],
    [
      "trades portfolio_id present and well-shaped, but NOT EQUAL to the caller-supplied portfolioId (real cross-check, not shape-only)",
      () =>
        clientWithFixtureBody({
          trades: [
            {
              id: 1,
              instrument: {
                code: "WHC",
                market_code: "ASX",
                currency_code: "AUD",
              },
              transaction_date: "2026-01-15",
              quantity: 1,
              price: 1,
              holding_id: 1,
              portfolio_id: 999, // well-shaped, but does not match "1" below
            },
          ],
        }).listTrades("1"),
    ],
    [
      "trades invalid transaction_type",
      () =>
        clientWithFixtureBody({
          trades: [
            {
              id: 1,
              instrument: {
                code: "WHC",
                market_code: "ASX",
                currency_code: "AUD",
              },
              transaction_type: "TRANSFER",
              transaction_date: "2026-01-15",
              quantity: 1,
              price: 1,
              holding_id: 1,
              portfolio_id: 1,
            },
          ],
        }).listTrades("1"),
    ],
    [
      "trades malformed value (present, not a decimal)",
      () =>
        clientWithFixtureBody({
          trades: [
            {
              id: 1,
              instrument: {
                code: "WHC",
                market_code: "ASX",
                currency_code: "AUD",
              },
              transaction_date: "2026-01-15",
              quantity: 1,
              price: 1,
              value: "not-a-number",
              holding_id: 1,
              portfolio_id: 1,
            },
          ],
        }).listTrades("1"),
    ],
    [
      "payouts missing amount",
      () =>
        clientWithFixtureBody({
          payouts: [
            {
              id: "pay1",
              instrument: {
                code: "IXJ",
                market_code: "ASX",
                currency_code: "AUD",
              },
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

// BRK-008: `transaction_type` is OPTIONAL (live evidence: the first item did
// not carry it at all) -- an absent value is a success with `null`, not a
// parse failure. `value` is nullable-tolerant the same way.
test("BRK-008 trades: an absent transaction_type/value parses successfully as null, not a failure", async () => {
  const result = await clientWithFixtureBody({
    trades: [
      {
        id: 1,
        instrument: { code: "WHC", market_code: "ASX", currency_code: "AUD" },
        transaction_date: "2026-01-15",
        quantity: 1,
        price: 1,
        holding_id: 1,
        portfolio_id: 1,
        // transaction_type / value genuinely absent.
      },
    ],
  }).listTrades("1");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value[0]?.transactionType, null);
    assert.equal(result.value[0]?.valueDecimal, null);
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
  const authFailureResult = await authFailureProvider.getAccessToken();
  capture(authFailureResult);
  // BRK-008: the allowlisted `error` code IS surfaced (exercised
  // end-to-end here), but `error_description` -- which carried the secret
  // above -- is discarded unread; the leak assertion below covers the
  // negative case across every captured value in this test.
  assert.equal(
    !authFailureResult.ok && authFailureResult.error.oauthErrorCode,
    "invalid_client",
  );

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

// --- BRK-008: payouts endpoint path fix + onBodyParseDiagnostic -----------

test("BRK-008: listPayouts requests the .json-suffixed endpoint path (Sharesight v3 payouts convention)", async () => {
  let calledUrl: string | null = null;
  const provider = await alwaysValidTokenProvider();
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async (url) => {
      calledUrl = String(url);
      return jsonResponse(200, { payouts: [] });
    },
  });
  const result = await client.listPayouts("port_1");
  assert.equal(result.ok, true);
  assert.equal(
    calledUrl,
    "https://api.sharesight.com/api/v3/portfolios/port_1/payouts.json",
  );
});

test("BRK-008: getPortfolioHoldings/listTrades request their un-suffixed v3-native paths, unchanged by the payouts fix", async () => {
  const provider = await alwaysValidTokenProvider();
  const calledUrls: string[] = [];
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async (url) => {
      calledUrls.push(String(url));
      return jsonResponse(200, { holdings: [], trades: [] });
    },
  });
  await client.getPortfolioHoldings("port_1");
  await client.listTrades("port_1");
  assert.deepEqual(calledUrls, [
    "https://api.sharesight.com/api/v3/portfolios/port_1/holdings",
    "https://api.sharesight.com/api/v3/portfolios/port_1/trades",
  ]);
});

test("BRK-008 onBodyParseDiagnostic: fires with metadata only when a response body is read but does not parse as JSON at all", async () => {
  const provider = await alwaysValidTokenProvider();
  const calls: Array<{
    endpoint: string;
    diagnostic: {
      contentType: string | null;
      httpStatus: number;
      bodyParseable: false;
      bodyBytes: number;
    };
  }> = [];
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async () =>
      new Response("<html>not json, an SPA fallback page</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    onBodyParseDiagnostic: (endpoint, diagnostic) => {
      calls.push({ endpoint, diagnostic });
    },
  });
  const result = await client.listPayouts("port_1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid_response");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, "listPayouts");
  assert.equal(calls[0].diagnostic.contentType, "text/html; charset=utf-8");
  assert.equal(calls[0].diagnostic.httpStatus, 200);
  assert.equal(calls[0].diagnostic.bodyParseable, false);
  assert.equal(
    calls[0].diagnostic.bodyBytes,
    "<html>not json, an SPA fallback page</html>".length,
  );
});

test("BRK-008 onBodyParseDiagnostic: never fires when JSON parses (even into an invalid domain shape) or on a timeout", async () => {
  const provider = await alwaysValidTokenProvider();
  let called = false;
  const onBodyParseDiagnostic = () => {
    called = true;
  };

  const validJson = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => jsonResponse(200, { portfolios: "not-an-array" }),
    onBodyParseDiagnostic,
  }).listPortfolios();
  assert.equal(validJson.ok, false);
  if (!validJson.ok) assert.equal(validJson.error.kind, "invalid_response");

  const timeoutResult = await createSharesightClient({
    tokenProvider: provider,
    timeoutMs: 15,
    fetcher: () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(jsonResponse(200, { portfolios: [] })), 250);
      }),
    onBodyParseDiagnostic,
  }).listPortfolios();
  assert.equal(timeoutResult.ok, false);
  if (!timeoutResult.ok) assert.equal(timeoutResult.error.kind, "timeout");

  assert.equal(called, false);
});

// --- BRK-008 (2026-08-15 follow-up): payouts wiring fix -- root cause was
// NOT a dropped callback (listPayouts wires onShapeEvidence/
// onBodyParseDiagnostic identically to the other three methods -- see the
// callback-wiring regression test below), it was that the `!response.ok`
// branch in `client.ts`'s `getJson` returned `invalid_response` with NO
// diagnostic evidence at all for ANY non-2xx status -- exactly matching the
// observed live symptom (invalid_response, neither onShapeEvidence nor
// onBodyParseDiagnostic firing). These tests pin the fix: onBodyParseDiagnostic
// now fires for a non-2xx response too, carrying transport metadata
// including `redirected` (Response.redirected) -- so a redirect to an HTML
// login/error page is visible even when its FINAL status is non-2xx. -------

test("BRK-008 onBodyParseDiagnostic: fires with transport metadata for a non-2xx response (2026-08-15 follow-up -- closes the non-2xx branch that emitted zero diagnostic evidence)", async () => {
  const provider = await alwaysValidTokenProvider();
  const calls: Array<{
    endpoint: string;
    diagnostic: {
      contentType: string | null;
      httpStatus: number;
      bodyParseable: false;
      bodyBytes: number;
      redirected: boolean;
    };
  }> = [];
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async () =>
      new Response("<html>404 not found</html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    onBodyParseDiagnostic: (endpoint, diagnostic) => {
      calls.push({ endpoint, diagnostic });
    },
  });
  const result = await client.listPayouts("port_1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid_response");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, "listPayouts");
  assert.equal(calls[0].diagnostic.httpStatus, 404);
  assert.equal(calls[0].diagnostic.contentType, "text/html; charset=utf-8");
  assert.equal(calls[0].diagnostic.bodyParseable, false);
  assert.equal(
    calls[0].diagnostic.bodyBytes,
    "<html>404 not found</html>".length,
  );
  assert.equal(calls[0].diagnostic.redirected, false);
});

test("BRK-008 onBodyParseDiagnostic: fires for every non-2xx-mapped kind (401/403/429/5xx), not only the invalid_response-mapped statuses", async () => {
  const provider = await alwaysValidTokenProvider();
  const cases: Array<{ status: number; expectedKind: string }> = [
    { status: 401, expectedKind: "authentication" },
    { status: 403, expectedKind: "entitlement" },
    { status: 429, expectedKind: "rate_limit" },
    { status: 500, expectedKind: "transient_upstream" },
  ];
  for (const { status, expectedKind } of cases) {
    let called = false;
    const result = await createSharesightClient({
      tokenProvider: provider,
      fetcher: async () => new Response("", { status }),
      onBodyParseDiagnostic: () => {
        called = true;
      },
    }).listPortfolios();
    assert.equal(result.ok, false, `status ${status}`);
    if (!result.ok)
      assert.equal(result.error.kind, expectedKind, `status ${status}`);
    assert.equal(
      called,
      true,
      `status ${status} should fire onBodyParseDiagnostic`,
    );
  }
});

test("BRK-008 onBodyParseDiagnostic: reports redirected=true when the underlying fetch followed a redirect before landing on the response -- the 3xx-shaped scenario the task called out (a redirect to an HTML login page, or to a non-2xx final status)", async () => {
  const provider = await alwaysValidTokenProvider();

  // Case 1: redirected to an HTML login page that itself responds 200 -- hits
  // the JSON.parse-throw branch. A test fetcher can't make a real fetch
  // follow a live redirect, so this duck-types a Response-shaped object with
  // `redirected: true` (exactly what a real fetch sets after following one)
  // -- only the properties client.ts actually reads are provided.
  const redirectedToHtmlLogin = {
    ok: true,
    status: 200,
    redirected: true,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text: async () => "<html>please log in</html>",
  } as unknown as Response;
  const htmlCalls: Array<{ endpoint: string; redirected: boolean }> = [];
  const htmlResult = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => redirectedToHtmlLogin,
    onBodyParseDiagnostic: (endpoint, diagnostic) => {
      htmlCalls.push({ endpoint, redirected: diagnostic.redirected });
    },
  }).listPayouts("port_1");
  assert.equal(htmlResult.ok, false);
  assert.equal(htmlCalls.length, 1);
  assert.equal(htmlCalls[0].endpoint, "listPayouts");
  assert.equal(htmlCalls[0].redirected, true);

  // Case 2: redirected, and the FINAL status is also non-2xx -- hits the
  // `!response.ok` branch (this is the branch that previously had NO
  // diagnostic at all).
  const redirectedToNonOk = {
    ok: false,
    status: 404,
    redirected: true,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text: async () => "<html>not found</html>",
  } as unknown as Response;
  const nonOkCalls: Array<{ endpoint: string; redirected: boolean }> = [];
  const nonOkResult = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => redirectedToNonOk,
    onBodyParseDiagnostic: (endpoint, diagnostic) => {
      nonOkCalls.push({ endpoint, redirected: diagnostic.redirected });
    },
  }).listPayouts("port_1");
  assert.equal(nonOkResult.ok, false);
  assert.equal(nonOkCalls.length, 1);
  assert.equal(nonOkCalls[0].endpoint, "listPayouts");
  assert.equal(nonOkCalls[0].redirected, true);
});

// --- BRK-008 review fix (2026-08-15 follow-up, B1): the non-2xx body read is
// opt-in, bounded, and independently timed -- an earlier version of the
// non-2xx diagnostic fix read the full body unconditionally, with no cap or
// dedicated timeout of its own, which review found could turn a call that
// previously returned promptly into one that hangs on a stalled/oversized
// error body. These tests pin the fix. ---------------------------------

/** Wraps a real `Response` in a `Proxy` that records whether ANY
 * body-reading member (`body`/`text`/`arrayBuffer`/`blob`/`json`/`bytes`)
 * was ever accessed -- used to PROVE the non-2xx body is never touched at
 * all when no caller has registered `onBodyParseDiagnostic` (a plain spy on
 * `text()` alone wouldn't catch a hypothetical future switch to a different
 * body-reading member). */
function trackedNonOkResponse(
  status: number,
  body: string,
): { response: Response; bodyAccessed: () => boolean } {
  const real = new Response(body, { status });
  let accessed = false;
  const guardedProps = new Set([
    "body",
    "text",
    "arrayBuffer",
    "blob",
    "json",
    "bytes",
  ]);
  const response = new Proxy(real, {
    get(target, prop) {
      if (typeof prop === "string" && guardedProps.has(prop)) {
        accessed = true;
      }
      // Reflect.get with the PROXY as receiver breaks native accessors that
      // brand-check `this` against a real Response instance (e.g. `ok`'s
      // internal private-field check) -- use `target` as the receiver so
      // those getters run against the real underlying Response.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    response: response as unknown as Response,
    bodyAccessed: () => accessed,
  };
}

test("BRK-008 review fix B1: with no onBodyParseDiagnostic registered, a non-2xx response's body is never read at all (proxied Response pins zero access) and the call returns promptly", async () => {
  const provider = await alwaysValidTokenProvider();
  const { response, bodyAccessed } = trackedNonOkResponse(
    404,
    "<html>404</html>",
  );
  const start = Date.now();
  const result = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => response,
    // Deliberately no onBodyParseDiagnostic.
  }).listPortfolios();
  const elapsedMs = Date.now() - start;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid_response");
  assert.equal(bodyAccessed(), false);
  assert.ok(elapsedMs < 200, `expected a prompt return, took ${elapsedMs}ms`);
});

/** A `Response`-shaped object whose body stream's `read()` never resolves --
 * simulates a stalled/slow-drip error body. Only the members `client.ts`
 * actually reads are provided. */
function stalledBodyNonOkResponse(status: number): Response {
  const reader = {
    read: () => new Promise<never>(() => {}), // never resolves
    cancel: async () => {},
  };
  const body = { getReader: () => reader };
  return {
    ok: false,
    status,
    redirected: false,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    body,
  } as unknown as Response;
}

test("BRK-008 review fix B1: a stalled non-2xx body (read() never resolves) still returns a typed result promptly, bounded by the read's own race timeout, when onBodyParseDiagnostic IS registered", async () => {
  const provider = await alwaysValidTokenProvider();
  const calls: Array<{ endpoint: string; bodyBytes: number }> = [];
  const start = Date.now();
  const result = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => stalledBodyNonOkResponse(404),
    onBodyParseDiagnostic: (endpoint, diagnostic) => {
      calls.push({ endpoint, bodyBytes: diagnostic.bodyBytes });
    },
  }).listPortfolios();
  const elapsedMs = Date.now() - start;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid_response");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, "listPortfolios");
  assert.equal(calls[0].bodyBytes, 0); // nothing was read before the stall
  // Bounded by the read's own ~1s race timeout, not the request's much
  // longer default timeoutMs (8s) and nowhere near "never resolves".
  assert.ok(
    elapsedMs < 3_000,
    `expected the read's own race timeout to bound this, took ${elapsedMs}ms`,
  );
});

test("BRK-008 review fix B1: a non-2xx body far larger than the byte bound is capped, never buffered unbounded", async () => {
  const provider = await alwaysValidTokenProvider();
  const HUGE_BODY = "x".repeat(50_000); // far beyond the 4,096-byte cap
  const calls: Array<{ bodyBytes: number }> = [];
  const result = await createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => new Response(HUGE_BODY, { status: 404 }),
    onBodyParseDiagnostic: (_endpoint, diagnostic) => {
      calls.push({ bodyBytes: diagnostic.bodyBytes });
    },
  }).listPortfolios();
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bodyBytes, 4_096);
});

test("BRK-008 onBodyParseDiagnostic: a throwing callback is caught and discarded, never failing the parse result it reacted to", async () => {
  const provider = await alwaysValidTokenProvider();
  const client = createSharesightClient({
    tokenProvider: provider,
    fetcher: async () => new Response("<not json>", { status: 200 }),
    onBodyParseDiagnostic: () => {
      throw new Error("boom -- caller-side diagnostic failure");
    },
  });
  const result = await client.listPayouts("port_1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "invalid_response");
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
