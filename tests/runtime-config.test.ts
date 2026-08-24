import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createRuntimeConfigErrorResponse,
  resolveRuntimeConfig,
} from "../worker/runtime-config.ts";

// IMP-010B review round (B2 ruling, honest flip): the ledger CSV import
// path's decode/parse work moved to the browser, so nothing in this
// codebase is fail-closed on CSV import by plan any more --
// `RuntimeConfig.csvImport` (the `enabled`/`reason` fields this test used
// to assert) was retired along with the `production-requires-paid-workers`
// gate it fed a now-false "Workers Free fails closed on CSV import" reason
// string into. See CSV_IMPORT_SPEC.md's IMP-010B section and
// `worker/runtime-config.ts`'s own `workersPlan` field comment for the full
// ruling.
test("local runtime defaults resolve with the free plan and a disabled provider", () => {
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

test("production accepts the approved provider set only -- Workers Paid is no longer required", () => {
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

  assert.equal(productionResult.config.workersPlan, "paid");

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

// IMP-010B review round (B2 ruling): this is the actual behavioral proof
// the owner's free-plan production directive requires -- a `production`
// deployment with `YIELDTOME_WORKERS_PLAN: "free"` must resolve
// successfully (previously: a hard 503 on every request via
// `production-requires-paid-workers`, now removed).
test("production resolves successfully under the free Workers plan -- the retired production-requires-paid-workers gate", () => {
  const result = resolveRuntimeConfig({
    ASSETS: {
      fetch: async () => new Response("ok"),
    },
    YIELDTOME_RUNTIME_ENV: "production",
    YIELDTOME_WORKERS_PLAN: "free",
    MARKET_DATA_PROVIDER: "disabled",
    CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUDIENCE: "audience",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.environment, "production");
  assert.equal(result.config.workersPlan, "free");
  assert.doesNotMatch(JSON.stringify(Object.keys(result.config)), /csvImport/);
});

test("no RuntimeConfigErrorCode is ever production-requires-paid-workers -- the gate is gone, not merely unreachable", async () => {
  const source = await readFile(
    new URL("../worker/runtime-config.ts", import.meta.url),
    "utf8",
  );
  // Matches an actual TS string-literal USE (the retired error-code union
  // member, or a `code: "..."` object literal) -- not this file's own
  // explanatory comments, which name the retired code in backticks, never
  // double-quotes.
  assert.doesNotMatch(source, /"production-requires-paid-workers"/);
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
