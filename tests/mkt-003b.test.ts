import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createMarketDataRefreshRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";
import {
  createMarketDataRefreshService,
  MARKET_DATA_REFRESH_LIMITS,
  type MarketDataRefreshServiceOptions,
} from "../domain/market-data/index.ts";
import type {
  FxObservation,
  MarketDataProvider,
  MarketDataResult,
  PriceObservation,
} from "../domain/market-data/contracts.ts";
import { runScheduledMarketDataRefresh } from "../worker/scheduled-refresh.ts";

async function createMigratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const migrationFiles = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    database.exec(
      await readFile(
        new URL(`../drizzle/${migrationFile}`, import.meta.url),
        "utf8",
      ),
    );
  }
  return database;
}

function seedMarketData(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits)
    VALUES
      ('AUD', 36, 'Australian dollar', 2),
      ('USD', 840, 'United States dollar', 2);
    INSERT INTO users (
      id, status, primary_email, timezone, created_at, updated_at, version
    ) VALUES (
      'user-a', 'active', 'a@example.com', 'Australia/Sydney',
      '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 1
    );
    INSERT INTO market_data_providers (
      id, code, name, capabilities_json, rate_limit_json
    ) VALUES (
      'yahoo-compatible', 'yahoo-best-effort', 'Yahoo', '{}', '{}'
    );
    INSERT INTO securities (
      id, asset_type, primary_currency_code, canonical_name,
      created_at, updated_at
    ) VALUES
      ('security-a', 'equity', 'AUD', 'Security A',
       '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z'),
      ('security-b', 'equity', 'AUD', 'Security B',
       '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z');
    INSERT INTO security_provider_mappings (
      id, security_id, provider_id, provider_exchange, provider_symbol,
      valid_from, status
    ) VALUES
      ('mapping-a', 'security-a', 'yahoo-compatible', 'ASX', 'AAA.AX',
       '2026-01-01', 'verified'),
      ('mapping-b', 'security-b', 'yahoo-compatible', 'ASX', 'BBB.AX',
       '2026-01-01', 'verified');
  `);
}

function priceObservation(
  date: string,
  closeDecimal: string,
  quality: PriceObservation["quality"] = "observed",
): PriceObservation {
  return {
    kind: "price",
    providerId: "yahoo-compatible",
    providerRevisionId: "revision-1",
    mappingId: "mapping-a",
    securityId: "security-a",
    scope: { kind: "deployment", userId: null },
    interval: "eod",
    observationAt: `${date}T00:00:00Z`,
    marketDate: date,
    marketTimezone: "Australia/Sydney",
    currencyCode: "AUD",
    closeDecimal,
    previousCloseDecimal: null,
    adjustmentState: "raw",
    adjustmentFactor: null,
    quality,
    delayedMinutes: null,
    ingestedAt: "2026-08-03T00:00:00Z",
    payloadSha256: null,
  };
}

function fxObservation(
  date: string,
  baseCurrencyCode = "AUD",
  quoteCurrencyCode = "USD",
): FxObservation {
  return {
    kind: "fx",
    providerId: "yahoo-compatible",
    providerRevisionId: `direct:${baseCurrencyCode}/${quoteCurrencyCode}`,
    scope: { kind: "user", userId: "user-a" },
    baseCurrencyCode,
    quoteCurrencyCode,
    rateDecimal: "0.67",
    interval: "eod",
    observedAt: `${date}T00:00:00Z`,
    marketDate: date,
    quality: "observed",
    delayedMinutes: null,
    ingestedAt: "2026-08-03T00:00:00Z",
    payloadSha256: null,
  };
}

function unavailable<T>(kind: "unavailable_capability"): MarketDataResult<T> {
  return {
    ok: false,
    error: { kind, message: "not used in this test", retryable: false },
  };
}

function providerFor(
  getDailyPrices: MarketDataProvider["getDailyPrices"],
  getFxRates: MarketDataProvider["getFxRates"] = async () =>
    unavailable<FxObservation[]>("unavailable_capability"),
): MarketDataProvider {
  return {
    capabilities: () => ({
      exchanges: [],
      intervals: ["eod"],
      supportsRawPrices: true,
      supportsAdjustedPrices: false,
      supportsFx: true,
      supportsDividends: false,
      supportsSplits: false,
      supportsFundamentals: false,
    }),
    searchSecurities: async () => unavailable("unavailable_capability"),
    getDailyPrices,
    getLatestObservation: async () => unavailable("unavailable_capability"),
    getFxRates,
    getDividendEvents: async () => unavailable("unavailable_capability"),
    getSplitEvents: async () => unavailable("unavailable_capability"),
  };
}

function serviceFor(
  database: DatabaseSync,
  provider: MarketDataProvider,
  overrides: Partial<MarketDataRefreshServiceOptions> = {},
) {
  return createMarketDataRefreshService({
    repository: createMarketDataRefreshRepository(
      createSqliteSqlClient(database),
    ),
    provider,
    now: () => "2026-08-03T01:00:00Z",
    randomId: (() => {
      let count = 0;
      return () => `worker-${++count}`;
    })(),
    sleep: async () => undefined,
    ...overrides,
  });
}

function priceJobInput(
  id: string,
  idempotencyKey: string,
  rangeFrom: string,
  rangeTo: string,
) {
  return {
    id,
    providerId: "yahoo-compatible",
    targetKind: "price" as const,
    targetKey: "mapping-a",
    mappingId: "mapping-a",
    securityId: "security-a",
    scope: { kind: "deployment" as const, userId: null },
    rangeFrom,
    rangeTo,
    chunkDays: 1,
    idempotencyKey,
    now: "2026-08-03T01:00:00Z",
  };
}

test("coalesces refreshes, resumes high-water chunks, and upserts corrections", async () => {
  const database = await createMigratedDatabase();
  seedMarketData(database);
  let call = 0;
  const provider = providerFor(async (request) => {
    call += 1;
    const date = request.from;
    return {
      ok: true,
      value: [priceObservation(date, call === 3 ? "102" : String(99 + call))],
    };
  });
  const service = serviceFor(database, provider);
  const first = await service.request(
    priceJobInput("job-price", "daily-1", "2026-07-29", "2026-07-30"),
  );
  const coalesced = await service.request(
    priceJobInput("job-price-duplicate", "daily-2", "2026-07-29", "2026-07-30"),
  );
  assert.equal(coalesced.id, first.id);

  const firstRun = await service.processPending();
  assert.deepEqual(firstRun, {
    jobsClaimed: 1,
    jobsCompleted: 0,
    jobsRetried: 0,
    jobsFailed: 0,
    providerRequests: 1,
    observationsWritten: 1,
  });
  assert.equal(
    (
      await serviceFor(database, provider).request(
        priceJobInput("job-price", "daily-1", "2026-07-29", "2026-07-30"),
      )
    ).id,
    first.id,
  );

  const secondRun = await service.processPending();
  assert.equal(secondRun.jobsCompleted, 1);
  assert.equal(secondRun.observationsWritten, 1);

  const correction = await service.request(
    priceJobInput("job-correction", "correction-1", "2026-07-30", "2026-07-30"),
  );
  assert.equal(correction.status, "queued");
  const correctionRun = await service.processPending();
  assert.equal(correctionRun.jobsCompleted, 1);
  const row = database
    .prepare(
      `SELECT close_decimal, quality FROM price_observations
       WHERE mapping_id = 'mapping-a' AND market_date = '2026-07-30'`,
    )
    .get() as { close_decimal: string; quality: string };
  assert.equal(row.close_decimal, "102");
  assert.equal(row.quality, "observed");
  assert.equal(
    (
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM price_observations WHERE mapping_id = 'mapping-a'",
        )
        .get() as { count: number }
    ).count,
    2,
  );
});

test("extends an overlapping running refresh through its upper bound", async () => {
  const database = await createMigratedDatabase();
  seedMarketData(database);
  const repository = createMarketDataRefreshRepository(
    createSqliteSqlClient(database),
  );
  const running = await repository.request(
    priceJobInput("job-running", "running-1", "2026-07-29", "2026-07-30"),
  );
  assert.equal(
    (
      await repository.claim(
        running.id,
        "worker-1",
        "2026-08-03T01:05:00Z",
        "2026-08-03T01:00:00Z",
      )
    ).ok,
    true,
  );

  const extended = await repository.request(
    priceJobInput(
      "job-running-extension",
      "running-2",
      "2026-07-30",
      "2026-08-02",
    ),
  );
  assert.equal(extended.id, running.id);
  assert.equal(extended.rangeFrom, "2026-07-29");
  assert.equal(extended.rangeTo, "2026-08-02");
  assert.equal(extended.status, "running");
});

test("retries throttled work, reclaims expired leases, and preserves user scope", async () => {
  const database = await createMigratedDatabase();
  seedMarketData(database);
  let call = 0;
  const provider = providerFor(
    async () => {
      return { ok: true, value: [] };
    },
    async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: false,
          error: {
            kind: "rate_limit",
            message: "throttled",
            retryable: true,
          },
        };
      }
      return { ok: true, value: [fxObservation("2026-07-29")] };
    },
  );
  const service = serviceFor(database, provider, {
    config: { retryBaseMs: 0 },
  });
  const first = await service.request({
    id: "job-fx",
    providerId: "yahoo-compatible",
    targetKind: "fx",
    targetKey: "AUD/USD",
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
    scope: { kind: "user", userId: "user-a" },
    rangeFrom: "2026-07-29",
    rangeTo: "2026-07-29",
    idempotencyKey: "fx-1",
    now: "2026-08-03T01:00:00Z",
  });
  assert.equal(first.scopeKey, "user-a");
  const retried = await service.processPending();
  assert.equal(retried.jobsRetried, 1);
  const completed = await service.processPending();
  assert.equal(completed.jobsCompleted, 1);
  const fxRow = database
    .prepare(
      "SELECT scope_key FROM fx_rate_observations WHERE base_currency_code = 'AUD'",
    )
    .get() as { scope_key: string };
  assert.equal(fxRow.scope_key, "user-a");

  const repository = createMarketDataRefreshRepository(
    createSqliteSqlClient(database),
  );
  const reclaim = await repository.request({
    id: "job-reclaim",
    providerId: "yahoo-compatible",
    targetKind: "fx",
    targetKey: "AUD/USD",
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
    scope: { kind: "user", userId: "user-a" },
    rangeFrom: "2026-07-29",
    rangeTo: "2026-07-29",
    idempotencyKey: "fx-reclaim",
    now: "2026-08-03T01:00:00Z",
  });
  assert.equal(
    (
      await repository.claim(
        reclaim.id,
        "expired-worker",
        "2026-08-03T01:00:10Z",
        "2026-08-03T01:00:00Z",
      )
    ).ok,
    true,
  );
  const reclaimed = await serviceFor(database, provider, {
    now: () => "2026-08-03T01:01:00Z",
  }).processPending();
  assert.equal(reclaimed.jobsCompleted, 1);
  assert.equal((await repository.get(reclaim.id))?.attempt, 2);
});

test("limits Cron work to bounded job and provider request budgets", async () => {
  assert.deepEqual(MARKET_DATA_REFRESH_LIMITS, {
    maxD1QueriesPerInvocation: 50,
    maxBoundParametersPerStatement: 100,
    maxWorkerMemoryBytes: 128 * 1024 * 1024,
    maxD1QueriesPerJob: 8,
  });
  const database = await createMigratedDatabase();
  seedMarketData(database);
  const provider = providerFor(async () => ({ ok: true, value: [] }));
  const service = serviceFor(database, provider, {
    config: { maxJobsPerInvocation: 2, maxProviderRequestsPerInvocation: 2 },
  });
  for (const [index, date] of [
    "2026-07-29",
    "2026-07-30",
    "2026-07-31",
  ].entries()) {
    await service.request(
      priceJobInput(`job-${index}`, `budget-${index}`, date, date),
    );
  }
  const summary = await service.processPending();
  assert.equal(summary.jobsClaimed, 2);
  assert.equal(summary.providerRequests, 2);
  assert.equal(
    (
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM market_data_refresh_jobs WHERE status = 'queued'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
});

test("scheduled handler is durable and does not use waitUntil for refresh work", async () => {
  const source = await readFile(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /async scheduled\(_controller, env\)/);
  assert.doesNotMatch(source, /scheduled[\s\S]{0,700}waitUntil/);
  const wrangler = JSON.parse(
    await readFile(new URL("../wrangler.json", import.meta.url), "utf8"),
  ) as { triggers?: { crons?: string[] } };
  assert.deepEqual(wrangler.triggers?.crons, ["0 * * * *"]);
  assert.deepEqual(
    await runScheduledMarketDataRefresh({
      ASSETS: { fetch: async () => new Response() },
      YIELDTOME_RUNTIME_ENV: "local",
      YIELDTOME_WORKERS_PLAN: "free",
      MARKET_DATA_PROVIDER: "disabled",
    } as unknown as Env),
    { ok: true, skipped: true, jobs: 0, providerRequests: 0 },
  );
});
