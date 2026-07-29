import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisabledMarketDataProvider,
  normalizeFxObservation,
  normalizePriceObservation,
  parseMarketDataProviderConfiguration,
  type ManualOverride,
  type NormalizationContext,
} from "../domain/market-data/index.ts";

const deploymentContext: NormalizationContext = {
  providerId: "yahoo-compatible",
  mappingId: "mapping-bhp",
  securityId: "security-bhp",
  scope: { kind: "deployment", userId: null },
  ingestedAt: "2026-07-30T00:01:00Z",
};

test("provider-neutral fixtures normalize deployment and user-scoped observations", () => {
  const price = normalizePriceObservation(
    {
      interval: "delayed",
      observationAt: "2026-07-30T00:00:00Z",
      marketDate: "2026-07-30",
      marketTimezone: "Australia/Sydney",
      currencyCode: "AUD",
      closeDecimal: "42.10",
      previousCloseDecimal: "41.90",
      adjustmentState: "raw",
      adjustmentFactor: "1",
      quality: "observed",
      delayedMinutes: 15,
      providerRevisionId: "revision-1",
      payloadSha256: "hash-1",
    },
    deploymentContext,
  );

  assert.equal(price.ok, true);
  if (!price.ok) {
    return;
  }
  assert.deepEqual(price.value.scope, { kind: "deployment", userId: null });
  assert.equal(price.value.providerRevisionId, "revision-1");
  assert.equal(price.value.delayedMinutes, 15);
  assert.equal(price.value.kind, "price");

  const userPrice = normalizePriceObservation(
    {
      interval: "eod",
      observationAt: "2026-07-30T00:00:00Z",
      marketDate: "2026-07-30",
      marketTimezone: "America/New_York",
      currencyCode: "USD",
      closeDecimal: "100.25",
      adjustmentState: "split_adjusted",
      quality: "corrected",
    },
    {
      ...deploymentContext,
      scope: { kind: "user", userId: "user-a" },
    },
  );

  assert.equal(userPrice.ok, true);
  if (userPrice.ok) {
    assert.deepEqual(userPrice.value.scope, { kind: "user", userId: "user-a" });
    assert.equal(userPrice.value.currencyCode, "USD");
  }
});

test("normalization rejects malformed values, outliers, and provider manual state", () => {
  const malformed = normalizePriceObservation(
    {
      interval: "intraday",
      observationAt: "not-a-date",
      marketDate: "2026-02-30",
      marketTimezone: "UTC",
      currencyCode: "AUD",
      closeDecimal: "-1.25",
      adjustmentState: "raw",
      quality: "manual",
    },
    deploymentContext,
  );

  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.error.kind, "invalid_response");
    assert.equal(malformed.error.retryable, false);
  }

  const invalidFx = normalizeFxObservation(
    {
      interval: "eod",
      baseCurrencyCode: "AUD",
      quoteCurrencyCode: "AUD",
      rateDecimal: "0",
      observedAt: "2026-07-30T00:00:00Z",
      marketDate: "2026-07-30",
      quality: "observed",
    },
    deploymentContext,
  );

  assert.equal(invalidFx.ok, false);
  if (!invalidFx.ok) {
    assert.equal(invalidFx.error.kind, "invalid_response");
  }
});

test("FX fixtures retain explicit base-to-quote direction and provenance", () => {
  const direct = normalizeFxObservation(
    {
      interval: "eod",
      baseCurrencyCode: "AUD",
      quoteCurrencyCode: "USD",
      rateDecimal: "0.6600",
      observedAt: "2026-07-30T00:00:00Z",
      marketDate: "2026-07-30",
      quality: "observed",
      payloadSha256: "fx-hash",
    },
    deploymentContext,
  );
  const inverse = normalizeFxObservation(
    {
      interval: "eod",
      baseCurrencyCode: "USD",
      quoteCurrencyCode: "AUD",
      rateDecimal: "1.5151",
      observedAt: "2026-07-30T00:00:00Z",
      marketDate: "2026-07-30",
      quality: "observed",
    },
    deploymentContext,
  );

  assert.equal(direct.ok, true);
  assert.equal(inverse.ok, true);
  if (direct.ok && inverse.ok) {
    assert.equal(direct.value.baseCurrencyCode, "AUD");
    assert.equal(direct.value.quoteCurrencyCode, "USD");
    assert.equal(inverse.value.baseCurrencyCode, "USD");
    assert.equal(inverse.value.quoteCurrencyCode, "AUD");
    assert.equal(direct.value.payloadSha256, "fx-hash");
  }
});

test("provider configuration is ordinary, fail-closed server configuration", async () => {
  const manualOverride: ManualOverride = {
    kind: "manual_override",
    userId: "user-a",
    portfolioId: "portfolio-a",
    securityId: "security-bhp",
    type: "price",
    targetKey: "security-bhp",
    effectiveFrom: "2026-07-30",
    effectiveTo: null,
    valueJson: '{"close":"42.10"}',
    reason: "Corrected exchange close",
    status: "active",
    supersedesOverrideId: null,
    createdAt: "2026-07-30T00:02:00Z",
  };
  const disabled = parseMarketDataProviderConfiguration("disabled");
  const enabled = parseMarketDataProviderConfiguration("yahoo-best-effort");
  const malformed = parseMarketDataProviderConfiguration({
    provider: "yahoo-best-effort",
    userCountGate: 1,
  });

  assert.equal(disabled.ok, true);
  assert.equal(enabled.ok, true);
  assert.equal(malformed.ok, false);
  assert.equal(manualOverride.kind, "manual_override");
  if (disabled.ok && enabled.ok) {
    assert.deepEqual(disabled.config, {
      code: "disabled",
      enabled: false,
      observationScope: "deployment",
    });
    assert.deepEqual(enabled.config, {
      code: "yahoo-best-effort",
      enabled: true,
      observationScope: "deployment",
    });
  }

  const provider = createDisabledMarketDataProvider();
  const result = await provider.getLatestObservation({
    mappingId: "mapping-bhp",
    securityId: "security-bhp",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "unavailable_capability");
    assert.equal(result.error.retryable, false);
  }
});
