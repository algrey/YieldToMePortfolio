import assert from "node:assert/strict";
import test from "node:test";
import {
  createYahooCompatibleProvider,
  type MarketDataProvider,
} from "../domain/market-data/index.ts";
import {
  australianChartFixture,
  searchFixture,
  unitedKingdomChartFixture,
  usChartFixture,
} from "./fixtures/yahoo-compatible.ts";

type FetchCall = { url: string; init: RequestInit | undefined };

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createFetcher(
  responseFor: (url: URL, callNumber: number) => Response | Promise<Response>,
  calls: FetchCall[],
) {
  let callNumber = 0;
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ url: url.toString(), init });
    callNumber += 1;
    return await responseFor(url, callNumber);
  };
}

function providerFor(
  fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>,
  overrides: Partial<Parameters<typeof createYahooCompatibleProvider>[0]> = {},
): MarketDataProvider {
  return createYahooCompatibleProvider({
    baseUrl: "https://provider.test",
    providerId: "yahoo-compatible",
    fetcher,
    resolveSymbol: async (mappingId) =>
      ({
        "mapping-au": "BHP.AX",
        "mapping-us": "AAPL",
        "mapping-uk": "SHEL.L",
      })[mappingId] ?? null,
    now: () => "2026-07-30T00:00:00Z",
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  });
}

const australianRequest = {
  mappingId: "mapping-au",
  securityId: "security-bhp",
  scope: { kind: "deployment" as const, userId: null },
};

test("normalizes Australian, US, and UK latest observations without provider payloads", async () => {
  const calls: FetchCall[] = [];
  const fetcher = createFetcher((url) => {
    const symbol = url.pathname.split("/").at(-1);
    if (symbol === "BHP.AX") return jsonResponse(australianChartFixture);
    if (symbol === "AAPL") return jsonResponse(usChartFixture);
    return jsonResponse(unitedKingdomChartFixture);
  }, calls);
  const provider = providerFor(fetcher);

  const au = await provider.getLatestObservation(australianRequest);
  const us = await provider.getLatestObservation({
    ...australianRequest,
    mappingId: "mapping-us",
    securityId: "security-aapl",
  });
  const uk = await provider.getLatestObservation({
    ...australianRequest,
    mappingId: "mapping-uk",
    securityId: "security-shell",
  });

  assert.equal(au.ok, true);
  assert.equal(us.ok, true);
  assert.equal(uk.ok, true);
  if (au.ok && au.value && us.ok && us.value && uk.ok && uk.value) {
    assert.deepEqual(
      [au.value.currencyCode, us.value.currencyCode, uk.value.currencyCode],
      ["AUD", "USD", "GBp"],
    );
    assert.equal(au.value.scope.kind, "deployment");
    assert.equal(au.value.mappingId, "mapping-au");
    assert.equal(au.value.interval, "delayed");
    assert.equal(au.value.delayedMinutes, 20);
    assert.equal(us.value.delayedMinutes, 15);
    assert.equal(uk.value.delayedMinutes, null);
    assert.equal(uk.value.interval, "eod");
    assert.equal("chart" in (au.value as Record<string, unknown>), false);
  }
  assert.equal(calls.length, 3);
  assert.match(calls[0]?.url ?? "", /v8\/finance\/chart\/BHP\.AX/);
});

test("normalizes daily raw history and provider symbol lookup", async () => {
  const calls: FetchCall[] = [];
  const provider = providerFor(
    createFetcher((url) => {
      if (url.pathname.includes("/search")) return jsonResponse(searchFixture);
      return jsonResponse(australianChartFixture);
    }, calls),
  );

  const search = await provider.searchSecurities({ text: "BHP" });
  assert.equal(search.ok, true);
  if (search.ok) {
    assert.deepEqual(
      search.value.map((candidate) => candidate.symbol),
      ["BHP.AX", "AAPL", "SHEL.L"],
    );
    assert.equal(search.value[0]?.securityId, null);
    assert.equal(search.value[0]?.currencyCode, "AUD");
  }

  const daily = await provider.getDailyPrices({
    ...australianRequest,
    from: "2026-07-28",
    to: "2026-07-29",
  });
  assert.equal(daily.ok, true);
  if (daily.ok) {
    assert.equal(daily.value.length, 2);
    assert.deepEqual(
      daily.value.map((observation) => observation.closeDecimal),
      ["41.5", "42.1"],
    );
    assert.deepEqual(
      daily.value.map((observation) => observation.marketDate),
      ["2026-07-28", "2026-07-29"],
    );
    assert.equal(daily.value[0]?.adjustmentState, "raw");
    assert.equal(daily.value[0]?.providerId, "yahoo-compatible");
    assert.equal(daily.value[0]?.ingestedAt, "2026-07-30T00:00:00Z");
  }
  assert.equal(calls.length, 2);
});

test("preserves an explicit unknown delay as an EOD observation", async () => {
  const provider = providerFor(async () =>
    jsonResponse({
      chart: {
        result: [
          {
            meta: {
              currency: "GBP",
              exchangeTimezoneName: "Europe/London",
              exchangeDataDelayedBy: null,
              regularMarketPrice: 725.5,
              regularMarketTime: Date.parse("2026-07-29T15:30:00Z") / 1000,
            },
            timestamp: [1_751_210_600],
            indicators: { quote: [{ close: [725.5] }] },
          },
        ],
      },
    }),
  );
  const result = await provider.getLatestObservation({
    ...australianRequest,
    mappingId: "mapping-uk",
    securityId: "security-shell",
  });

  assert.equal(result.ok, true);
  if (result.ok && result.value) {
    assert.equal(result.value.delayedMinutes, null);
    assert.equal(result.value.interval, "eod");
  }
});

test("retries throttle responses, bounds timeout attempts, and trips the circuit", async () => {
  const retryCalls: FetchCall[] = [];
  const retryProvider = providerFor(
    createFetcher(
      (_url, callNumber) =>
        callNumber === 1
          ? jsonResponse({ error: "slow down" }, 429, { "retry-after": "0" })
          : jsonResponse(australianChartFixture),
      retryCalls,
    ),
    { maxAttempts: 2 },
  );
  const retried = await retryProvider.getLatestObservation(australianRequest);
  assert.equal(retried.ok, true);
  assert.equal(retryCalls.length, 2);

  const timeoutProvider = providerFor(
    async () => await new Promise<Response>(() => undefined),
    { maxAttempts: 2, timeoutMs: 1 },
  );
  const timedOut =
    await timeoutProvider.getLatestObservation(australianRequest);
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.error.kind, "timeout");

  let circuitCalls = 0;
  const circuitProvider = providerFor(
    async () => {
      circuitCalls += 1;
      return jsonResponse({ error: "upstream" }, 503);
    },
    { maxAttempts: 1, circuitFailureThreshold: 2 },
  );
  await circuitProvider.getLatestObservation(australianRequest);
  await circuitProvider.getLatestObservation(australianRequest);
  const circuitOpen =
    await circuitProvider.getLatestObservation(australianRequest);
  assert.equal(circuitCalls, 2);
  assert.equal(circuitOpen.ok, false);
  if (!circuitOpen.ok)
    assert.equal(circuitOpen.error.kind, "transient_upstream");
});

test("uses stale latest fallback and fails closed for missing symbols or schema changes", async () => {
  let callNumber = 0;
  const provider = providerFor(
    async () => {
      callNumber += 1;
      return callNumber === 1
        ? jsonResponse(australianChartFixture)
        : jsonResponse({ changed: true });
    },
    { maxAttempts: 1 },
  );
  const fresh = await provider.getLatestObservation(australianRequest);
  assert.equal(fresh.ok, true);
  const stale = await provider.getLatestObservation(australianRequest);
  assert.equal(stale.ok, true);
  if (stale.ok && stale.value) {
    assert.equal(stale.value.quality, "stale_candidate");
    assert.equal(stale.value.closeDecimal, "42.1");
  }

  const missing = await providerFor(async () =>
    jsonResponse({}, 404),
  ).getLatestObservation({
    ...australianRequest,
    mappingId: "missing",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.kind, "symbol_not_found");

  const malformedDecimal = await providerFor(
    async () =>
      jsonResponse({
        chart: {
          result: [
            {
              meta: {
                currency: "AUD",
                exchangeTimezoneName: "Australia/Sydney",
              },
              timestamp: [Date.parse("2026-07-29T00:00:00Z") / 1000],
              indicators: { quote: [{ close: ["NaN"] }] },
            },
          ],
        },
      }),
    { maxAttempts: 1 },
  ).getDailyPrices({
    ...australianRequest,
    from: "2026-07-29",
    to: "2026-07-29",
  });
  assert.equal(malformedDecimal.ok, false);
  if (!malformedDecimal.ok) {
    assert.equal(malformedDecimal.error.kind, "invalid_response");
  }

  const malformedDate = await providerFor(async () => {
    throw new Error("request should not be attempted");
  }).getDailyPrices({
    ...australianRequest,
    from: "2026-02-30",
    to: "2026-03-01",
  });
  assert.equal(malformedDate.ok, false);
  if (!malformedDate.ok)
    assert.equal(malformedDate.error.kind, "invalid_response");

  const malformed = await providerFor(
    async () => jsonResponse({ chart: { result: [{}] } }),
    {
      maxAttempts: 1,
    },
  ).getDailyPrices({
    ...australianRequest,
    from: "2026-07-28",
    to: "2026-07-29",
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.kind, "invalid_response");
});

test("deferred capabilities remain typed and provider configuration has no source gate", async () => {
  const provider = providerFor(async () =>
    jsonResponse(australianChartFixture),
  );
  assert.equal(provider.capabilities().supportsFx, true);
  const dividends = await provider.getDividendEvents({
    securityId: "security-bhp",
    from: "2026-07-28",
    to: "2026-07-29",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(dividends.ok, false);
  if (!dividends.ok)
    assert.equal(dividends.error.kind, "unavailable_capability");
  const splits = await provider.getSplitEvents({
    securityId: "security-bhp",
    from: "2026-07-28",
    to: "2026-07-29",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(splits.ok, false);
  if (!splits.ok) assert.equal(splits.error.kind, "unavailable_capability");
});
