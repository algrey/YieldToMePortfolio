import { createMarketDataRefreshRepository } from "../db/repositories/market-data-refresh.ts";
import { getSqlClient } from "../db/d1-sql-client.ts";
import {
  createMarketDataRefreshService,
  createYahooCompatibleProvider,
  runDueCorporateActionRefresh,
} from "../domain/market-data/index.ts";
import { resolveRuntimeConfig } from "./runtime-config.ts";
import {
  CRON_CALCULATION_BUDGET_PER_PORTFOLIO,
  CRON_MAX_PORTFOLIOS_PER_SWEEP,
  sweepCalculationRuns,
} from "../app/calculation-executor-service.ts";

const CORPORATE_ACTION_PROVIDER_ID = "yahoo-compatible";

export type ScheduledRefreshResult =
  | { ok: true; skipped: boolean; jobs: number; providerRequests: number }
  | { ok: false; reason: "configuration" | "database" | "refresh" };

function buildProvider(client: Awaited<ReturnType<typeof getSqlClient>>) {
  return createYahooCompatibleProvider({
    providerId: CORPORATE_ACTION_PROVIDER_ID,
    fetcher: fetch,
    resolveSymbol: async (mappingId) => {
      const mapping = await client.get<{ provider_symbol: string }>(
        `SELECT provider_symbol FROM security_provider_mappings
         WHERE id = ? AND provider_id = 'yahoo-compatible'
           AND status = 'verified' LIMIT 1`,
        [mappingId],
      );
      return mapping?.provider_symbol ?? null;
    },
  });
}

export async function runScheduledMarketDataRefresh(
  env: Env,
): Promise<ScheduledRefreshResult> {
  const runtimeConfig = resolveRuntimeConfig(env);
  if (!runtimeConfig.ok) return { ok: false, reason: "configuration" };
  if (runtimeConfig.config.marketDataProvider === "disabled") {
    return { ok: true, skipped: true, jobs: 0, providerRequests: 0 };
  }

  try {
    const client = await getSqlClient();
    const provider = buildProvider(client);
    const service = createMarketDataRefreshService({
      repository: createMarketDataRefreshRepository(client),
      provider,
    });
    const summary = await service.processPending();
    return {
      ok: true,
      skipped: false,
      jobs: summary.jobsClaimed,
      providerRequests: summary.providerRequests,
    };
  } catch {
    return { ok: false, reason: "refresh" };
  }
}

export type ScheduledCorporateActionRefreshResult =
  | {
      ok: true;
      skipped: boolean;
      securitiesProcessed: number;
      securitiesFailed: number;
    }
  | { ok: false; reason: "configuration" | "refresh" };

/**
 * Ingestion trigger (b) (MKT-005): runs alongside the price/FX Cron refresh
 * and re-pulls a small bounded batch of securities' dividend/split history
 * per invocation via `runDueCorporateActionRefresh` -- see that function's
 * doc comment and `db/repositories/dividends.ts`'s
 * `createCorporateActionRefreshRepository` for why this is a separate,
 * simpler sweep rather than an extension of the price/FX chunked job queue.
 */
export async function runScheduledCorporateActionRefresh(
  env: Env,
): Promise<ScheduledCorporateActionRefreshResult> {
  const runtimeConfig = resolveRuntimeConfig(env);
  if (!runtimeConfig.ok) return { ok: false, reason: "configuration" };
  if (runtimeConfig.config.marketDataProvider === "disabled") {
    return {
      ok: true,
      skipped: true,
      securitiesProcessed: 0,
      securitiesFailed: 0,
    };
  }

  try {
    const client = await getSqlClient();
    const provider = buildProvider(client);
    const summary = await runDueCorporateActionRefresh({
      client,
      provider,
      providerId: CORPORATE_ACTION_PROVIDER_ID,
      scope: { kind: "deployment", userId: null },
    });
    return {
      ok: true,
      skipped: false,
      securitiesProcessed: summary.securitiesProcessed,
      securitiesFailed: summary.securitiesFailed,
    };
  } catch {
    return { ok: false, reason: "refresh" };
  }
}

export type ScheduledCalculationSweepResult =
  | { ok: true; portfolios: number; advanced: number; completed: number }
  | { ok: false; reason: "database" | "sweep" };

/**
 * CALC-003 trigger 3: the cron backstop for the bounded calculation-run
 * executor (`app/calculation-executor-service.ts`). Runs alongside the
 * existing hourly price/FX and corporate-action sweeps (same `scheduled`
 * handler, `worker/index.ts`) so an abandoned/interrupted run (a crashed
 * request-path invocation whose lease has since expired) or a run that
 * simply never got a request-time trigger (no reader ever hit the
 * read-time trigger for that portfolio) eventually still gets advanced and
 * published, without needing configuration-gated provider access -- unlike
 * the other two scheduled refreshes, this does not depend on
 * `MARKET_DATA_PROVIDER`.
 */
export async function runScheduledCalculationSweep(): Promise<ScheduledCalculationSweepResult> {
  try {
    const client = await getSqlClient();
    const summary = await sweepCalculationRuns(
      { client },
      {
        maxPortfolios: CRON_MAX_PORTFOLIOS_PER_SWEEP,
        budgetPerPortfolio: CRON_CALCULATION_BUDGET_PER_PORTFOLIO,
      },
    );
    return {
      ok: true,
      portfolios: summary.portfoliosSwept,
      advanced: summary.advanced,
      completed: summary.completed,
    };
  } catch {
    return { ok: false, reason: "sweep" };
  }
}
