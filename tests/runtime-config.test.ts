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
  const workerTypes = await readFile(
    new URL("../worker-configuration.d.ts", import.meta.url),
    "utf8",
  );

  assert.equal(wranglerSource.compatibility_date, "2026-07-29");
  assert.deepEqual(wranglerSource.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(wranglerSource.d1_databases, [
    {
      binding: "DB",
      database_name: "yieldtome-portfolio",
      database_id: "17b674b8-034a-4e78-9916-dab14499bb9c",
    },
  ]);
  assert.deepEqual(wranglerSource.r2_buckets ?? [], []);

  const sourceVars = wranglerSource.vars as Record<string, string>;
  const sourceEnvs = wranglerSource.env as Record<
    string,
    {
      vars: Record<string, string>;
      secrets: { required: string[] };
      d1_databases?: Array<{
        binding: string;
        database_name: string;
        database_id?: string;
      }>;
    }
  >;
  assert.equal(sourceVars.YIELDTOME_RUNTIME_ENV, "local");
  assert.equal(sourceVars.YIELDTOME_WORKERS_PLAN, "free");
  assert.equal(sourceVars.MARKET_DATA_PROVIDER, "disabled");
  assert.equal(sourceVars.CLOUDFLARE_ACCESS_ISSUER, undefined);
  assert.equal(sourceVars.CLOUDFLARE_ACCESS_AUDIENCE, undefined);
  assert.deepEqual(sourceEnvs.preview.d1_databases, [
    {
      binding: "DB",
      database_name: "yieldtome-portfolio-preview",
      database_id: "c236e389-f41f-439e-8352-5b489c391428",
    },
  ]);
  assert.equal(sourceEnvs.preview.vars.YIELDTOME_RUNTIME_ENV, "preview");
  assert.equal(sourceEnvs.preview.vars.YIELDTOME_WORKERS_PLAN, "free");
  assert.deepEqual(sourceEnvs.preview.secrets.required, [
    "CLOUDFLARE_ACCESS_ISSUER",
    "CLOUDFLARE_ACCESS_AUDIENCE",
  ]);
  assert.deepEqual(sourceEnvs.production.d1_databases, [
    {
      binding: "DB",
      database_name: "yieldtome-portfolio-production",
    },
  ]);
  assert.equal(sourceEnvs.production.vars.YIELDTOME_RUNTIME_ENV, "production");
  assert.equal(sourceEnvs.production.vars.YIELDTOME_WORKERS_PLAN, "paid");
  assert.deepEqual(sourceEnvs.production.secrets.required, [
    "CLOUDFLARE_ACCESS_ISSUER",
    "CLOUDFLARE_ACCESS_AUDIENCE",
  ]);

  const generatedAssets = generatedConfig.assets as { binding?: string };
  assert.equal(generatedAssets.binding, "ASSETS");
  // DEP-001: wrangler >=4.120.0 / @cloudflare/vite-plugin >=1.51.1 fill in a
  // default `migrations_dir` on every generated `d1_databases` entry. This
  // repository applies D1 migrations via explicit `drizzle/*.sql` files and
  // `wrangler d1 execute` (see docs/OPS-002_BACKUP_RESTORE_RUNBOOK.md), never
  // `wrangler d1 migrations apply`, so the field is inert generated metadata,
  // not a behavior change.
  assert.deepEqual(generatedConfig.d1_databases, [
    {
      binding: "DB",
      database_name: "yieldtome-portfolio",
      database_id: "17b674b8-034a-4e78-9916-dab14499bb9c",
      migrations_dir: "../../migrations",
    },
  ]);
  assert.deepEqual(generatedConfig.r2_buckets, []);
  assert.match(workerTypes.slice(0, 1200), /\bDB: D1Database;/);
  assert.doesNotMatch(builtWorker, /\bIMAGES\b/);
});
