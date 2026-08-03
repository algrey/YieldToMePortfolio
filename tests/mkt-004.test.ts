import assert from "node:assert/strict";
import test from "node:test";
import {
  createYahooCompatibleProvider,
  selectFxObservation,
  type MarketDataProvider,
} from "../domain/market-data/index.ts";
import { australianUsdFxFixture } from "./fixtures/yahoo-compatible.ts";

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

function providerFor(
  responseFor: (url: URL, callNumber: number) => Response | Promise<Response>,
  calls: FetchCall[],
  overrides: Partial<Parameters<typeof createYahooCompatibleProvider>[0]> = {},
): MarketDataProvider {
  let callNumber = 0;
  return createYahooCompatibleProvider({
    baseUrl: "https://provider.test",
    providerId: "yahoo-compatible",
    fetcher: async (input, init) => {
      const url = new URL(input);
      calls.push({ url: url.toString(), init });
      callNumber += 1;
      return responseFor(url, callNumber);
    },
    resolveSymbol: async () => null,
    now: () => "2026-07-31T00:00:00Z",
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  });
}

const deploymentScope = { kind: "deployment" as const, userId: null };

test("loads directional AUD/USD FX history with explicit direct and inverse rates", async () => {
  const directCalls: FetchCall[] = [];
  const direct = providerFor(
    () => jsonResponse(australianUsdFxFixture),
    directCalls,
  );
  const directResult = await direct.getFxRates({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
    from: "2026-07-29",
    to: "2026-07-30",
    scope: deploymentScope,
  });
  assert.equal(directResult.ok, true);
  if (directResult.ok) {
    assert.deepEqual(
      directResult.value.map((observation) => [
        observation.baseCurrencyCode,
        observation.quoteCurrencyCode,
        observation.rateDecimal,
        observation.providerRevisionId,
      ]),
      [
        ["AUD", "USD", "0.66", "direct:AUD/USD"],
        ["AUD", "USD", "0.67", "direct:AUD/USD"],
      ],
    );
    assert.equal(directResult.value[0]?.scope.kind, "deployment");
    assert.equal(directResult.value[0]?.interval, "eod");
    assert.equal(directResult.value[0]?.ingestedAt, "2026-07-31T00:00:00Z");
  }
  assert.equal(directCalls.length, 1);
  assert.match(directCalls[0]?.url ?? "", /chart\/AUDUSD%3DX/);
  if (directResult.ok) {
    const weekendSelection = selectFxObservation({
      asOf: "2026-08-01",
      targetKey: "AUD/USD",
      baseCurrencyCode: "AUD",
      quoteCurrencyCode: "USD",
      observations: directResult.value,
    });
    assert.equal(weekendSelection.status, "fallback");
    assert.equal(weekendSelection.selected?.marketDate, "2026-07-30");
  }

  const inverseCalls: FetchCall[] = [];
  const inverse = providerFor(
    () => jsonResponse(australianUsdFxFixture),
    inverseCalls,
  );
  const inverseResult = await inverse.getFxRates({
    baseCurrencyCode: "USD",
    quoteCurrencyCode: "AUD",
    from: "2026-07-29",
    to: "2026-07-30",
    scope: { kind: "user", userId: "user-a" },
  });
  assert.equal(inverseResult.ok, true);
  if (inverseResult.ok) {
    assert.deepEqual(
      inverseResult.value.map((observation) => [
        observation.baseCurrencyCode,
        observation.quoteCurrencyCode,
        observation.rateDecimal,
        observation.providerRevisionId,
      ]),
      [
        ["USD", "AUD", "1.515151515151515152", "inverted:AUD/USD"],
        ["USD", "AUD", "1.492537313432835821", "inverted:AUD/USD"],
      ],
    );
    assert.deepEqual(inverseResult.value[0]?.scope, {
      kind: "user",
      userId: "user-a",
    });
  }
  assert.equal(inverseCalls.length, 1);
});

test("identity conversion is local and unsupported FX pairs stay unavailable", async () => {
  const calls: FetchCall[] = [];
  const provider = providerFor(
    () => jsonResponse(australianUsdFxFixture),
    calls,
  );
  const identity = await provider.getFxRates({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "AUD",
    from: "2026-07-29",
    to: "2026-07-30",
    scope: deploymentScope,
  });
  assert.deepEqual(identity, { ok: true, value: [] });
  const unsupported = await provider.getFxRates({
    baseCurrencyCode: "EUR",
    quoteCurrencyCode: "JPY",
    from: "2026-07-29",
    to: "2026-07-30",
    scope: deploymentScope,
  });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok)
    assert.equal(unsupported.error.kind, "unavailable_capability");
  assert.equal(calls.length, 0);
});

test("rejects zero, malformed, future, and invalid FX observations", async () => {
  const cases = [
    {
      name: "zero",
      body: {
        ...australianUsdFxFixture,
        chart: {
          ...australianUsdFxFixture.chart,
          result: [
            {
              ...australianUsdFxFixture.chart.result[0],
              indicators: { quote: [{ close: [0, 0.67] }] },
            },
          ],
        },
      },
    },
    {
      name: "malformed",
      body: {
        ...australianUsdFxFixture,
        chart: {
          ...australianUsdFxFixture.chart,
          result: [
            {
              ...australianUsdFxFixture.chart.result[0],
              indicators: { quote: [{ close: ["not-a-rate", 0.67] }] },
            },
          ],
        },
      },
    },
    {
      name: "future",
      body: {
        ...australianUsdFxFixture,
        chart: {
          ...australianUsdFxFixture.chart,
          result: [
            {
              ...australianUsdFxFixture.chart.result[0],
              timestamp: [
                australianUsdFxFixture.chart.result[0].timestamp[0],
                Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000),
              ],
            },
          ],
        },
      },
    },
    {
      name: "wrong provider currency",
      body: {
        ...australianUsdFxFixture,
        chart: {
          ...australianUsdFxFixture.chart,
          result: [
            {
              ...australianUsdFxFixture.chart.result[0],
              meta: {
                ...australianUsdFxFixture.chart.result[0].meta,
                currency: "AUD",
              },
            },
          ],
        },
      },
    },
    {
      name: "wrong provider symbol",
      body: {
        ...australianUsdFxFixture,
        chart: {
          ...australianUsdFxFixture.chart,
          result: [
            {
              ...australianUsdFxFixture.chart.result[0],
              meta: {
                ...australianUsdFxFixture.chart.result[0].meta,
                symbol: "EURUSD=X",
              },
            },
          ],
        },
      },
    },
  ];
  for (const testCase of cases) {
    const result = await providerFor(() => jsonResponse(testCase.body), [], {
      maxAttempts: 1,
    }).getFxRates({
      baseCurrencyCode: "AUD",
      quoteCurrencyCode: "USD",
      from: "2026-07-29",
      to: "2026-07-30",
      scope: deploymentScope,
    });
    assert.equal(result.ok, false, testCase.name);
    if (!result.ok) assert.equal(result.error.kind, "invalid_response");
  }
  const invalidRange = await providerFor(() => {
    throw new Error("invalid range must not call provider");
  }, []).getFxRates({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
    from: "2026-02-30",
    to: "2026-03-01",
    scope: deploymentScope,
  });
  assert.equal(invalidRange.ok, false);
  if (!invalidRange.ok)
    assert.equal(invalidRange.error.kind, "invalid_response");
});

test("retries throttled FX requests and fails closed on changed schemas", async () => {
  const retryCalls: FetchCall[] = [];
  const retryProvider = providerFor(
    (_url, callNumber) =>
      callNumber === 1
        ? jsonResponse({ error: "slow down" }, 429, { "retry-after": "0" })
        : jsonResponse(australianUsdFxFixture),
    retryCalls,
    { maxAttempts: 2 },
  );
  const retried = await retryProvider.getFxRates({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
    from: "2026-07-29",
    to: "2026-07-30",
    scope: deploymentScope,
  });
  assert.equal(retried.ok, true);
  assert.equal(retryCalls.length, 2);

  const malformed = await providerFor(
    () => jsonResponse({ chart: { result: [{ meta: {} }] } }),
    [],
    { maxAttempts: 1 },
  ).getFxRates({
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
    from: "2026-07-29",
    to: "2026-07-30",
    scope: deploymentScope,
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.kind, "invalid_response");
});
