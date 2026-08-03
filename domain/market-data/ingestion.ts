import type {
  FxObservation,
  MarketDataProvider,
  PriceObservation,
} from "./contracts.ts";
import type {
  MarketDataRefreshJobRecord,
  RequestMarketDataRefreshInput,
} from "../../db/repositories/market-data-refresh.ts";
import {
  MARKET_DATA_REFRESH_REPOSITORY_LIMITS,
  type createMarketDataRefreshRepository,
} from "../../db/repositories/market-data-refresh.ts";

type RefreshRepository = ReturnType<typeof createMarketDataRefreshRepository>;

export type MarketDataRefreshServiceOptions = {
  repository: RefreshRepository;
  provider: MarketDataProvider;
  now?: () => string;
  randomId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  config?: Partial<MarketDataRefreshConfig>;
};

export type MarketDataRefreshConfig = {
  maxJobsPerInvocation: number;
  maxProviderRequestsPerInvocation: number;
  maxChunkDays: number;
  maxObservationsPerChunk: number;
  maxAttempts: number;
  leaseMs: number;
  retryBaseMs: number;
  maxRetryDelayMs: number;
  minProviderIntervalMs: number;
};

export const MARKET_DATA_REFRESH_LIMITS = {
  maxD1QueriesPerInvocation: 50,
  maxBoundParametersPerStatement: 100,
  maxWorkerMemoryBytes: 128 * 1024 * 1024,
  maxD1QueriesPerJob: 8,
} as const;

export const DEFAULT_MARKET_DATA_REFRESH_CONFIG: MarketDataRefreshConfig = {
  maxJobsPerInvocation: 5,
  maxProviderRequestsPerInvocation: 5,
  maxChunkDays: 5,
  maxObservationsPerChunk: 5,
  maxAttempts: 3,
  leaseMs: 45_000,
  retryBaseMs: 1_000,
  maxRetryDelayMs: 30_000,
  minProviderIntervalMs: 0,
};

function validateConfig(config: MarketDataRefreshConfig): void {
  const positiveIntegers = [
    config.maxJobsPerInvocation,
    config.maxProviderRequestsPerInvocation,
    config.maxChunkDays,
    config.maxObservationsPerChunk,
    config.maxAttempts,
    config.leaseMs,
  ];
  const d1QueryBudget =
    1 +
    config.maxJobsPerInvocation * MARKET_DATA_REFRESH_LIMITS.maxD1QueriesPerJob;
  if (
    positiveIntegers.some((value) => !Number.isInteger(value) || value < 1) ||
    config.retryBaseMs < 0 ||
    config.maxRetryDelayMs < 0 ||
    config.minProviderIntervalMs < 0 ||
    config.maxProviderRequestsPerInvocation > config.maxJobsPerInvocation ||
    config.maxChunkDays > DEFAULT_MARKET_DATA_REFRESH_CONFIG.maxChunkDays ||
    config.maxObservationsPerChunk >
      MARKET_DATA_REFRESH_REPOSITORY_LIMITS.maxObservationsPerChunk ||
    d1QueryBudget > MARKET_DATA_REFRESH_LIMITS.maxD1QueriesPerInvocation
  ) {
    throw new Error("invalid_market_data_refresh_config");
  }
}

export type MarketDataRefreshSummary = {
  jobsClaimed: number;
  jobsCompleted: number;
  jobsRetried: number;
  jobsFailed: number;
  providerRequests: number;
  observationsWritten: number;
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

function dateInRange(date: string, from: string, to: string): boolean {
  return validDate(date) && date >= from && date <= to;
}

function observationMatchesJob(
  job: MarketDataRefreshJobRecord,
  observation: {
    providerId: string;
    scope: { kind: "deployment" | "user"; userId: string | null };
    marketDate: string;
    kind: "price" | "fx";
    mappingId?: string;
    securityId?: string;
    baseCurrencyCode?: string;
    quoteCurrencyCode?: string;
  },
  from: string,
  to: string,
): boolean {
  const sameScope =
    observation.scope.kind === job.scope.kind &&
    (observation.scope.kind === "deployment" ||
      observation.scope.userId === job.scope.userId);
  if (
    observation.providerId !== job.providerId ||
    observation.kind !== job.targetKind ||
    !sameScope ||
    !dateInRange(observation.marketDate, from, to)
  ) {
    return false;
  }
  if (job.targetKind === "price") {
    return (
      observation.mappingId === job.mappingId &&
      observation.securityId === job.securityId
    );
  }
  return (
    observation.baseCurrencyCode === job.baseCurrencyCode &&
    observation.quoteCurrencyCode === job.quoteCurrencyCode
  );
}

export function createMarketDataRefreshService(
  options: MarketDataRefreshServiceOptions,
) {
  const now = options.now ?? (() => new Date().toISOString());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const config = {
    ...DEFAULT_MARKET_DATA_REFRESH_CONFIG,
    ...options.config,
  };
  validateConfig(config);

  async function retryOrFail(
    job: MarketDataRefreshJobRecord,
    leaseOwner: string,
    kind: string,
    retryable: boolean,
    at: string,
    summary: MarketDataRefreshSummary,
  ): Promise<void> {
    if (retryable && job.attempt < config.maxAttempts) {
      const delay = Math.min(
        config.maxRetryDelayMs,
        config.retryBaseMs * 2 ** Math.max(0, job.attempt - 1),
      );
      const retry = await options.repository.retry(
        job.id,
        leaseOwner,
        new Date(Date.parse(at) + delay).toISOString(),
        kind,
        at,
      );
      if (retry.ok) summary.jobsRetried += 1;
      return;
    }
    const failed = await options.repository.fail(job.id, leaseOwner, kind, at);
    if (failed.ok) summary.jobsFailed += 1;
  }

  async function processJob(
    job: MarketDataRefreshJobRecord,
    summary: MarketDataRefreshSummary,
    providerRequests: { count: number },
  ): Promise<void> {
    const leaseOwner = randomId();
    const startedAt = now();
    const claimed = await options.repository.claim(
      job.id,
      leaseOwner,
      new Date(Date.parse(startedAt) + config.leaseMs).toISOString(),
      startedAt,
    );
    if (!claimed.ok) return;
    summary.jobsClaimed += 1;
    const activeJob = claimed.job;
    const chunkFrom = activeJob.highWaterDate
      ? addDays(activeJob.highWaterDate, 1)
      : activeJob.rangeFrom;
    const chunkTo = minDate(
      activeJob.rangeTo,
      addDays(
        chunkFrom,
        Math.min(activeJob.chunkDays, config.maxChunkDays) - 1,
      ),
    );

    if (
      !validDate(chunkFrom) ||
      !validDate(chunkTo) ||
      chunkFrom > chunkTo ||
      providerRequests.count >= config.maxProviderRequestsPerInvocation
    ) {
      await retryOrFail(
        activeJob,
        leaseOwner,
        "invalid_response",
        false,
        now(),
        summary,
      );
      return;
    }

    if (providerRequests.count > 0 && config.minProviderIntervalMs > 0) {
      await sleep(config.minProviderIntervalMs);
    }
    providerRequests.count += 1;
    summary.providerRequests += 1;

    let result:
      | Awaited<ReturnType<MarketDataProvider["getDailyPrices"]>>
      | Awaited<ReturnType<MarketDataProvider["getFxRates"]>>;
    try {
      result =
        activeJob.targetKind === "price"
          ? await options.provider.getDailyPrices({
              mappingId: activeJob.mappingId as string,
              securityId: activeJob.securityId as string,
              from: chunkFrom,
              to: chunkTo,
              scope: activeJob.scope,
            })
          : await options.provider.getFxRates({
              baseCurrencyCode: activeJob.baseCurrencyCode as string,
              quoteCurrencyCode: activeJob.quoteCurrencyCode as string,
              from: chunkFrom,
              to: chunkTo,
              scope: activeJob.scope,
            });
    } catch {
      await retryOrFail(
        activeJob,
        leaseOwner,
        "transient_upstream",
        true,
        now(),
        summary,
      );
      return;
    }

    if (!result.ok) {
      await retryOrFail(
        activeJob,
        leaseOwner,
        result.error.kind,
        result.error.retryable,
        now(),
        summary,
      );
      return;
    }

    if (result.value.length > config.maxObservationsPerChunk) {
      await retryOrFail(
        activeJob,
        leaseOwner,
        "invalid_response",
        false,
        now(),
        summary,
      );
      return;
    }

    const observations = result.value.filter((observation) =>
      observationMatchesJob(activeJob, observation, chunkFrom, chunkTo),
    );
    if (observations.length !== result.value.length) {
      await retryOrFail(
        activeJob,
        leaseOwner,
        "invalid_response",
        false,
        now(),
        summary,
      );
      return;
    }

    try {
      const progress = await options.repository.commitChunk({
        id: activeJob.id,
        leaseOwner,
        expectedHighWaterDate: activeJob.highWaterDate,
        highWaterDate: chunkTo,
        observations: observations as readonly (
          PriceObservation | FxObservation
        )[],
        correctionCount: 0,
        now: now(),
      });
      if (progress.ok) {
        summary.observationsWritten += observations.length;
        if (progress.job.status === "completed") summary.jobsCompleted += 1;
      }
    } catch {
      await retryOrFail(
        activeJob,
        leaseOwner,
        "transient_upstream",
        true,
        now(),
        summary,
      );
    }
  }

  return {
    async request(
      input: RequestMarketDataRefreshInput,
    ): Promise<MarketDataRefreshJobRecord> {
      return options.repository.request({
        ...input,
        chunkDays: Math.max(
          1,
          Math.min(input.chunkDays ?? config.maxChunkDays, config.maxChunkDays),
        ),
      });
    },

    async processPending(): Promise<MarketDataRefreshSummary> {
      const summary: MarketDataRefreshSummary = {
        jobsClaimed: 0,
        jobsCompleted: 0,
        jobsRetried: 0,
        jobsFailed: 0,
        providerRequests: 0,
        observationsWritten: 0,
      };
      const currentTime = now();
      const jobs = await options.repository.listClaimable(
        currentTime,
        config.maxJobsPerInvocation,
      );
      const providerRequests = { count: 0 };
      for (const job of jobs) {
        if (providerRequests.count >= config.maxProviderRequestsPerInvocation) {
          break;
        }
        await processJob(job, summary, providerRequests);
      }
      return summary;
    },
  };
}
