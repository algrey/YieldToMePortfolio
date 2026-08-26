// MKT-021 -- Frankfurter (ECB reference rate) FX provider for the Quotes
// tab's currency watchlist rows (owner directive, 2026-08-26). Covers:
// GET-only transport smuggling rejection, response parsing/validation
// (fixture JSON incl. malformed), provenance fields (eod/observed/
// deployment-scope/payloadSha256), unavailable states (network failure,
// invalid currency, timeout -- never zero/fabricated), the converging
// same-day upsert (no ordering guard needed), the `frankfurter` provider
// seed row, the best-effort on-add prime wired into
// `addWatchlistCurrencyPairWithContext`, and the deliberately-unchanged
// Change-column em-dash decision. All fixture/mock based -- no live
// network, per this codebase's own convention (mirrors `tests/brk-003.test.ts`'s
// header note).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import { loadOwnedWatchlist } from "../app/owned-watchlist.ts";
import { watchlistExplanation } from "../app/watchlist-contract.ts";
import {
  addWatchlistCurrencyPairWithContext,
  type WatchlistActionContext,
} from "../app/watchlist-actions.ts";
import {
  createFrankfurterFxClient,
  FRANKFURTER_PROVIDER_ID,
  type FrankfurterFxClient,
} from "../domain/market-data/index.ts";
import {
  FrankfurterNonGetAttemptError,
  frankfurterGet,
  type FrankfurterFetcher,
} from "../domain/market-data/frankfurter-transport.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A `FrankfurterFetcher` that always answers with the given fixture body. */
function fixtureFetcher(status: number, body: unknown): FrankfurterFetcher {
  return async () => jsonResponse(status, body);
}

async function loadMigrationSql(): Promise<string> {
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const contents = await Promise.all(
    files.map((file) =>
      readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    ),
  );
  return contents.join("\n");
}

async function database(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(await loadMigrationSql());
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
  `);
  return db;
}

function actionContext(
  client: SqlClient,
  userId: string,
): WatchlistActionContext {
  return { client, userId, requestId: `request-${userId}` };
}

/** A `FrankfurterFxClient` that always answers with the given result. */
function stubFxClient(
  getLatestRate: FrankfurterFxClient["getLatestRate"],
): FrankfurterFxClient {
  return { getLatestRate };
}

// ---------------------------------------------------------------------------
// GET-only transport (mirrors tests/brk-003.test.ts's identical Sharesight
// smuggling drill)
// ---------------------------------------------------------------------------

test("MKT-021 transport: frankfurterGet is GET-only and rejects a smuggled method/header before ever calling the fetcher", async () => {
  let called = false;
  const fetcher: FrankfurterFetcher = async () => {
    called = true;
    return jsonResponse(200, {});
  };
  const url = new URL("https://api.frankfurter.dev/v2/rate/AUD/USD");

  const response = await frankfurterGet(fetcher, url, {
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200);
  assert.equal(called, true);

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    called = false;
    const smuggled = { method } as unknown as Parameters<
      typeof frankfurterGet
    >[2];
    assert.throws(
      () => frankfurterGet(fetcher, url, smuggled),
      FrankfurterNonGetAttemptError,
    );
    assert.equal(called, false, `${method} must never reach the fetcher`);
  }

  called = false;
  const overrideHeader = {
    headers: { "X-HTTP-Method-Override": "DELETE" },
  } as unknown as Parameters<typeof frankfurterGet>[2];
  assert.throws(
    () => frankfurterGet(fetcher, url, overrideHeader),
    FrankfurterNonGetAttemptError,
  );
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Response parsing/validation + provenance
// ---------------------------------------------------------------------------

test("MKT-021 client: the owner's exact endpoint shape parses into a fully-provenanced eod/observed FxObservation", async () => {
  const client = createFrankfurterFxClient({
    fetcher: fixtureFetcher(200, {
      date: "2026-08-26",
      base: "AUD",
      quote: "USD",
      rate: 0.71512,
    }),
    now: () => "2026-08-26T01:00:00.000Z",
  });
  const result = await client.getLatestRate({
    baseCurrencyCode: "aud",
    quoteCurrencyCode: "usd",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.providerId, FRANKFURTER_PROVIDER_ID);
  assert.equal(result.value.baseCurrencyCode, "AUD");
  assert.equal(result.value.quoteCurrencyCode, "USD");
  // JSON-number-to-decimal-string: the established `String(value)`
  // precedent (`yahoo-compatible.ts`'s `positiveDecimal`), never a
  // fabricated re-rounding.
  assert.equal(result.value.rateDecimal, "0.71512");
  assert.equal(result.value.marketDate, "2026-08-26");
  assert.equal(result.value.observedAt, "2026-08-26T00:00:00Z");
  assert.equal(result.value.interval, "eod");
  assert.equal(result.value.quality, "observed");
  assert.equal(result.value.delayedMinutes, null);
  assert.deepEqual(result.value.scope, { kind: "deployment", userId: null });
  assert.equal(result.value.ingestedAt, "2026-08-26T01:00:00.000Z");
  assert.equal(typeof result.value.payloadSha256, "string");
  assert.equal(result.value.payloadSha256!.length, 64);
});

test("MKT-021 client: malformed/mismatched responses degrade to invalid_response, never a fabricated rate", async () => {
  const cases: Array<{ name: string; body: unknown }> = [
    {
      name: "missing rate",
      body: { date: "2026-08-26", base: "AUD", quote: "USD" },
    },
    {
      name: "zero rate",
      body: { date: "2026-08-26", base: "AUD", quote: "USD", rate: 0 },
    },
    {
      name: "negative rate",
      body: { date: "2026-08-26", base: "AUD", quote: "USD", rate: -1 },
    },
    {
      name: "non-numeric rate",
      body: { date: "2026-08-26", base: "AUD", quote: "USD", rate: "0.7" },
    },
    {
      name: "mismatched base",
      body: { date: "2026-08-26", base: "NZD", quote: "USD", rate: 0.6 },
    },
    {
      name: "malformed date",
      body: { date: "not-a-date", base: "AUD", quote: "USD", rate: 0.7 },
    },
    { name: "not an object", body: "oops" },
  ];
  for (const testCase of cases) {
    const client = createFrankfurterFxClient({
      fetcher: fixtureFetcher(200, testCase.body),
    });
    const result = await client.getLatestRate({
      baseCurrencyCode: "AUD",
      quoteCurrencyCode: "USD",
    });
    assert.equal(result.ok, false, testCase.name);
    if (result.ok) continue;
    assert.equal(result.error.kind, "invalid_response", testCase.name);
    assert.equal(result.error.retryable, false, testCase.name);
  }
});

test("MKT-021 client: an invalid currency code (422) is a non-retryable invalid_response, never retried", async () => {
  let calls = 0;
  const fetcher: FrankfurterFetcher = async () => {
    calls += 1;
    return jsonResponse(422, { status: 422, message: "invalid currency: ZZZ" });
  };
  const client = createFrankfurterFxClient({ fetcher, maxAttempts: 3 });
  const result = await client.getLatestRate({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "invalid_response");
  assert.equal(result.error.retryable, false);
  assert.equal(calls, 1, "a non-retryable status must not be retried");
});

test("MKT-021 client: a same-currency pair is rejected before any request is sent", async () => {
  let called = false;
  const client = createFrankfurterFxClient({
    fetcher: async () => {
      called = true;
      return jsonResponse(200, {});
    },
  });
  const result = await client.getLatestRate({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "AUD",
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

// Review fold (cheap #2): malformed currency codes -- including a
// path-traversal-shaped value, since `getLatestRate` interpolates the
// (validated) codes directly into a URL path
// (`${baseUrl}/rate/${base}/${quote}`) -- must be rejected BEFORE any
// request is built, never merely produce a 404/422 from a request that was
// actually sent somewhere unintended.
test("MKT-021 client: malformed currency codes (path-traversal-shaped, wrong length, too-short-after-uppercasing) are rejected before any request is sent, on either side of the pair", async () => {
  const malformed = ["AUD/../", "AUDX", "au", "", "AU D", "../../etc"];
  for (const code of malformed) {
    let called = false;
    const client = createFrankfurterFxClient({
      fetcher: async () => {
        called = true;
        return jsonResponse(200, {});
      },
    });
    const baseResult = await client.getLatestRate({
      baseCurrencyCode: code,
      quoteCurrencyCode: "USD",
    });
    assert.equal(baseResult.ok, false, `base=${JSON.stringify(code)}`);
    assert.equal(
      called,
      false,
      `base=${JSON.stringify(code)} must never reach the fetcher`,
    );

    const quoteResult = await client.getLatestRate({
      baseCurrencyCode: "AUD",
      quoteCurrencyCode: code,
    });
    assert.equal(quoteResult.ok, false, `quote=${JSON.stringify(code)}`);
    assert.equal(
      called,
      false,
      `quote=${JSON.stringify(code)} must never reach the fetcher`,
    );
  }
});

test("MKT-021 client: a transient 503 retries up to maxAttempts then degrades honestly, never fabricating success", async () => {
  let calls = 0;
  const fetcher: FrankfurterFetcher = async () => {
    calls += 1;
    return jsonResponse(503, { status: 503, message: "unavailable" });
  };
  const client = createFrankfurterFxClient({
    fetcher,
    maxAttempts: 3,
    sleep: async () => {},
  });
  const result = await client.getLatestRate({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "transient_upstream");
  assert.equal(result.error.retryable, true);
  assert.equal(calls, 3);
});

test("MKT-021 client: a network failure degrades to a retryable transient_upstream error, never a crash", async () => {
  const client = createFrankfurterFxClient({
    fetcher: async () => {
      throw new Error("network down");
    },
    maxAttempts: 1,
  });
  const result = await client.getLatestRate({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "transient_upstream");
  assert.equal(result.error.retryable, true);
});

// ---------------------------------------------------------------------------
// Migration seed
// ---------------------------------------------------------------------------

test("MKT-021 migration: the frankfurter provider row is seeded and enabled", async () => {
  const db = await database();
  const row = db
    .prepare("SELECT id, code, status FROM market_data_providers WHERE id = ?")
    .get(FRANKFURTER_PROVIDER_ID) as
    { id: string; code: string; status: string } | undefined;
  assert.ok(row, "expected a seeded frankfurter provider row");
  assert.equal(row!.code, "frankfurter");
  assert.equal(row!.status, "enabled");
  db.close();
});

// ---------------------------------------------------------------------------
// End-to-end: add-time prime writes a converging fx_rate_observations row,
// which the watchlist read path then surfaces (Last Price + reference date),
// with the Change column left honestly unavailable throughout.
// ---------------------------------------------------------------------------

test("MKT-021 actions: addWatchlistCurrencyPair primes a real fx_rate_observations row via the injected Frankfurter client, and the watchlist renders it", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const fxClient = stubFxClient(async () => ({
    ok: true,
    value: {
      kind: "fx",
      providerId: FRANKFURTER_PROVIDER_ID,
      providerRevisionId: null,
      scope: { kind: "deployment", userId: null },
      baseCurrencyCode: "AUD",
      quoteCurrencyCode: "USD",
      rateDecimal: "0.71512",
      interval: "eod",
      observedAt: "2026-08-26T00:00:00Z",
      marketDate: "2026-08-26",
      quality: "observed",
      delayedMinutes: null,
      ingestedAt: "2026-08-26T01:00:00Z",
      payloadSha256: "a".repeat(64),
    },
  }));

  const added = await addWatchlistCurrencyPairWithContext(
    context,
    { baseCurrencyCode: "AUD", quoteCurrencyCode: "USD" },
    { fxClient },
  );
  assert.equal(added.ok, true);

  const stored = db
    .prepare(
      `SELECT provider_id, rate_decimal, market_date, access_scope
       FROM fx_rate_observations WHERE base_currency_code = 'AUD' AND quote_currency_code = 'USD'`,
    )
    .get() as
    | {
        provider_id: string;
        rate_decimal: string;
        market_date: string;
        access_scope: string;
      }
    | undefined;
  assert.ok(stored, "expected the prime to write a fx_rate_observations row");
  assert.equal(stored!.provider_id, FRANKFURTER_PROVIDER_ID);
  assert.equal(stored!.rate_decimal, "0.71512");
  assert.equal(stored!.market_date, "2026-08-26");
  assert.equal(stored!.access_scope, "deployment");

  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-26T05:00:00Z"),
  });
  const pairRow = rows.find((row) => row.kind === "currency_pair");
  assert.ok(pairRow);
  assert.equal(pairRow!.price, "0.71512 USD");
  assert.equal(pairRow!.timeLine, "2026-08-26");
  assert.equal(pairRow!.state, "current");
  // WLT-001's own reviewed decision, deliberately UNCHANGED by MKT-021 (see
  // docs/MARKET_DATA_STRATEGY.md §25's "Change column" section): a
  // currency-pair row's change stays the honest em-dash state even once a
  // real Frankfurter observation exists, since `FxObservation` still
  // carries no previous-rate field.
  assert.equal(pairRow!.change, "—");
  assert.equal(pairRow!.percent, "—");
  // MKT-021 review (B1, BLOCKING): pin the FULL accessible explanation
  // string, not merely the absence of "live" -- this is exactly the
  // surface the reviewer caught rendering "NaN minute delay" and provider
  // revision "undefined" for every primed Frankfurter row, because
  // `fx_rate_observations` has neither a `delayed_minutes` nor a
  // `provider_revision_id` column and `mapFxObservation`
  // (`app/owned-watchlist.ts`) used to read them anyway (`undefined`
  // slipping an `=== null` check). `providerRevisionId` does not appear in
  // this string at all (`watchlistExplanation` never renders it), so the
  // "NaN minute delay" text is the one this pin exists to catch --
  // `delayedMinutes` is hard-nulled now, so this renders the honest
  // "delay not reported" instead. (The trailing ".." is a pre-existing,
  // out-of-scope quirk: `selection.explanation.reason` already ends in its
  // own period before `watchlistExplanation`'s template appends another --
  // identical to the security-row wording, not something MKT-021
  // introduced.)
  const explanation = watchlistExplanation(pairRow!);
  assert.ok(!explanation.toLowerCase().includes("live"));
  assert.ok(!explanation.includes("NaN"));
  assert.ok(!explanation.includes("undefined"));
  assert.equal(
    explanation,
    "Validated quote as of 2026-08-26. Source: provider frankfurter; " +
      "observation timestamp: 2026-08-26T00:00:00Z; delay not reported; " +
      "scope: deployment; quality: observed; fallback: The best validated " +
      "FX observation for the requested date was selected..",
  );
  db.close();
});

test("MKT-021 actions: a Frankfurter failure at add-time is silently absorbed -- the pair is still added, honestly unavailable", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const fxClient = stubFxClient(async () => ({
    ok: false,
    error: { kind: "transient_upstream", message: "down", retryable: true },
  }));

  const added = await addWatchlistCurrencyPairWithContext(
    context,
    { baseCurrencyCode: "AUD", quoteCurrencyCode: "USD" },
    { fxClient },
  );
  assert.equal(added.ok, true);

  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a");
  const pairRow = rows.find((row) => row.kind === "currency_pair");
  assert.ok(pairRow);
  assert.equal(pairRow!.price, "unavailable");
  assert.equal(pairRow!.state, "unavailable");
  db.close();
});

test("MKT-021 actions: with no fxClient injected, adding a currency pair never makes a real network call (node-test fallback stays disabled)", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const added = await addWatchlistCurrencyPairWithContext(context, {
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
  });
  assert.equal(added.ok, true);
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a");
  const pairRow = rows.find((row) => row.kind === "currency_pair");
  assert.ok(pairRow);
  assert.equal(pairRow!.price, "unavailable");
  db.close();
});

test("MKT-021 actions: priming the same pair twice on the same reference date converges onto ONE row (no duplicate, no ordering guard needed)", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  let call = 0;
  const fxClient = stubFxClient(async () => {
    call += 1;
    return {
      ok: true,
      value: {
        kind: "fx",
        providerId: FRANKFURTER_PROVIDER_ID,
        providerRevisionId: null,
        scope: { kind: "deployment", userId: null },
        baseCurrencyCode: "AUD",
        quoteCurrencyCode: "USD",
        // Second call reports a corrected rate for the SAME reference date
        // -- exercises the plain `ON CONFLICT DO UPDATE` convergence path.
        rateDecimal: call === 1 ? "0.71512" : "0.71600",
        interval: "eod",
        observedAt: "2026-08-26T00:00:00Z",
        marketDate: "2026-08-26",
        quality: "observed",
        delayedMinutes: null,
        ingestedAt: "2026-08-26T01:00:00Z",
        payloadSha256: "b".repeat(64),
      },
    };
  });

  await addWatchlistCurrencyPairWithContext(
    context,
    { baseCurrencyCode: "AUD", quoteCurrencyCode: "USD" },
    { fxClient },
  );
  // `primeWatchlistCurrencyPairRate` is deliberately not exported (mirrors
  // `primeWatchlistSecurityPrice`'s own internal visibility) -- convergence
  // is exercised via a second `addWatchlistCurrencyPairWithContext` call.
  // `addCurrencyPair` itself is an idempotent no-op on a repeat add (its own
  // `WHERE NOT EXISTS` guard, `db/repositories/watchlist.ts`), but this
  // wiring calls the best-effort prime again regardless of whether the add
  // was fresh -- exactly what a second real-world "add" attempt (or a
  // retried request) would do.
  await addWatchlistCurrencyPairWithContext(
    context,
    { baseCurrencyCode: "AUD", quoteCurrencyCode: "USD" },
    { fxClient },
  );

  const count = db
    .prepare(
      `SELECT COUNT(*) AS count FROM fx_rate_observations
       WHERE base_currency_code = 'AUD' AND quote_currency_code = 'USD'
         AND provider_id = ?`,
    )
    .get(FRANKFURTER_PROVIDER_ID) as { count: number };
  assert.equal(
    count.count,
    1,
    "same-day re-prime must converge, not duplicate",
  );
  const stored = db
    .prepare(
      `SELECT rate_decimal FROM fx_rate_observations
       WHERE base_currency_code = 'AUD' AND quote_currency_code = 'USD'
         AND provider_id = ?`,
    )
    .get(FRANKFURTER_PROVIDER_ID) as { rate_decimal: string };
  assert.equal(stored.rate_decimal, "0.71600", "the newer prime must win");
  assert.equal(call, 2);
  db.close();
});
