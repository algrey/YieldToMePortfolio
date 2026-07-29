import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createRuntimeConfigErrorResponse,
  resolveRuntimeConfig,
} from "../worker/runtime-config.ts";

test("local runtime defaults stay fail-closed on CSV import and provider is disabled", () => {
  const result = resolveRuntimeConfig({
    ASSETS: {
      fetch: async () => new Response("ok"),
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.config.environment, "local");
  assert.equal(result.config.workersPlan, "free");
  assert.equal(result.config.marketDataProvider, "disabled");
  assert.equal(result.config.csvImport.enabled, false);
  assert.match(
    result.config.csvImport.reason ?? "",
    /Workers Free fails closed on CSV import/i,
  );
});

test("preview and production fail closed when Access config is missing", () => {
  for (const [environment, workersPlan] of [
    ["preview", "free"],
    ["production", "paid"],
  ] as const) {
    const result = resolveRuntimeConfig({
      ASSETS: {
        fetch: async () => new Response("ok"),
      },
      YIELDTOME_RUNTIME_ENV: environment,
      YIELDTOME_WORKERS_PLAN: workersPlan,
      MARKET_DATA_PROVIDER: "disabled",
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      continue;
    }

    assert.deepEqual(result.errors.map((error) => error.code).sort(), [
      "missing-access-audience",
      "missing-access-issuer",
    ]);

    const response = createRuntimeConfigErrorResponse(result.errors);
    assert.equal(response.status, 503);
  }
});

test("production requires Workers Paid and accepts the approved provider set only", () => {
  const productionResult = resolveRuntimeConfig({
    ASSETS: {
      fetch: async () => new Response("ok"),
    },
    YIELDTOME_RUNTIME_ENV: "production",
    YIELDTOME_WORKERS_PLAN: "paid",
    MARKET_DATA_PROVIDER: "yahoo-best-effort",
    CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUDIENCE: "audience",
  });

  assert.equal(productionResult.ok, true);
  if (!productionResult.ok) {
    return;
  }

  assert.equal(productionResult.config.csvImport.enabled, true);
  assert.equal(productionResult.config.csvImport.maxRows, 100_000);

  const unsupportedProviderResult = resolveRuntimeConfig({
    ASSETS: {
      fetch: async () => new Response("ok"),
    },
    YIELDTOME_RUNTIME_ENV: "production",
    YIELDTOME_WORKERS_PLAN: "paid",
    MARKET_DATA_PROVIDER: "alpha-vantage",
    CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUDIENCE: "audience",
  });

  assert.equal(unsupportedProviderResult.ok, false);
  if (!unsupportedProviderResult.ok) {
    assert.match(
      unsupportedProviderResult.errors.map((error) => error.code).join(","),
      /invalid-market-data-provider/,
    );
  }
});

test("wrangler source and generated worker config stay aligned with the task profile", async () => {
  const wranglerSource = JSON.parse(
    await readFile(new URL("../wrangler.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const generatedConfig = JSON.parse(
    await readFile(
      new URL("../dist/server/wrangler.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const builtWorker = await readFile(
    new URL("../dist/server/index.js", import.meta.url),
    "utf8",
  );

  assert.equal(wranglerSource.compatibility_date, "2026-07-29");
  assert.deepEqual(wranglerSource.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(wranglerSource.d1_databases ?? [], []);
  assert.deepEqual(wranglerSource.r2_buckets ?? [], []);

  const sourceVars = wranglerSource.vars as Record<string, string>;
  const sourceEnvs = wranglerSource.env as Record<
    string,
    { vars: Record<string, string>; secrets: { required: string[] } }
  >;
  assert.equal(sourceVars.YIELDTOME_RUNTIME_ENV, "local");
  assert.equal(sourceVars.YIELDTOME_WORKERS_PLAN, "free");
  assert.equal(sourceVars.MARKET_DATA_PROVIDER, "disabled");
  assert.equal(sourceVars.CLOUDFLARE_ACCESS_ISSUER, undefined);
  assert.equal(sourceVars.CLOUDFLARE_ACCESS_AUDIENCE, undefined);
  assert.equal(sourceEnvs.preview.vars.YIELDTOME_RUNTIME_ENV, "preview");
  assert.equal(sourceEnvs.preview.vars.YIELDTOME_WORKERS_PLAN, "free");
  assert.deepEqual(sourceEnvs.preview.secrets.required, [
    "CLOUDFLARE_ACCESS_ISSUER",
    "CLOUDFLARE_ACCESS_AUDIENCE",
  ]);
  assert.equal(sourceEnvs.production.vars.YIELDTOME_RUNTIME_ENV, "production");
  assert.equal(sourceEnvs.production.vars.YIELDTOME_WORKERS_PLAN, "paid");
  assert.deepEqual(sourceEnvs.production.secrets.required, [
    "CLOUDFLARE_ACCESS_ISSUER",
    "CLOUDFLARE_ACCESS_AUDIENCE",
  ]);

  const generatedAssets = generatedConfig.assets as { binding?: string };
  assert.equal(generatedAssets.binding, "ASSETS");
  assert.deepEqual(generatedConfig.d1_databases, []);
  assert.deepEqual(generatedConfig.r2_buckets, []);
  assert.doesNotMatch(builtWorker, /\bIMAGES\b/);
});
