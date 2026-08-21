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
import { runSharesightPriceRefresh } from "../app/sharesight-price-refresh-service.ts";
import { createSharesightIntegrationConfig } from "./sharesight-config.ts";
import { createYahooAuthConfig } from "./yahoo-auth-config.ts";

const CORPORATE_ACTION_PROVIDER_ID = "yahoo-compatible";

export type ScheduledRefreshResult =
  | { ok: true; skipped: boolean; jobs: number; providerRequests: number }
  | { ok: false; reason: "configuration" | "database" | "refresh" };

function buildProvider(
  client: Awaited<ReturnType<typeof getSqlClient>>,
  env: Env,
) {
  // MKT-009B: optional login-cookie jar, inert (`enabled: false`) when
  // `YAHOO_COOKIE_T`/`YAHOO_COOKIE_Y` are absent -- see
  // `worker/yahoo-auth-config.ts`'s doc comment.
  const authConfig = createYahooAuthConfig(
    env as unknown as Parameters<typeof createYahooAuthConfig>[0],
  );
  return createYahooCompatibleProvider({
    providerId: CORPORATE_ACTION_PROVIDER_ID,
    fetcher: fetch,
    auth: authConfig.enabled ? authConfig.credentials : null,
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
    const provider = buildProvider(client, env);
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
    const provider = buildProvider(client, env);
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

export type ScheduledSharesightPriceRefreshResult =
  | {
      ok: true;
      skipped: boolean;
      usersProcessed: number;
      usersFailed: number;
      matchedCount: number;
      unmatchedCount: number;
      invalidTimestampCount: number;
      observationsWritten: number;
    }
  | {
      ok: false;
      reason: "fetch_failed";
      errorKind: string;
      usersMarkedFailed: number;
    }
  | { ok: false; reason: "database" };

/**
 * BRK-012B trigger: runs alongside the existing hourly price/FX and
 * corporate-action sweeps (same `scheduled` handler, `worker/index.ts`).
 * Gated on BOTH `SHARESIGHT_CLIENT_ID`/`SHARESIGHT_CLIENT_SECRET` being
 * configured (`createSharesightIntegrationConfig`'s `{ enabled: false }`
 * typed state, never a thrown error) AND at least one owner having an
 * enabled `sharesight_sync_state` link -- `runSharesightPriceRefresh`
 * itself enforces both gates with zero DB reads/Sharesight requests when
 * either is absent (see that module's doc comment); this wrapper only
 * builds the client and reports the outcome, mirroring
 * `runScheduledMarketDataRefresh`'s shape exactly.
 */
export async function runScheduledSharesightPriceRefresh(
  env: Env,
): Promise<ScheduledSharesightPriceRefreshResult> {
  try {
    const client = await getSqlClient();
    const integration = createSharesightIntegrationConfig(
      env as unknown as Parameters<typeof createSharesightIntegrationConfig>[0],
    );
    const result = await runSharesightPriceRefresh({
      client,
      sharesightClient: integration.enabled ? integration.client : null,
    });
    return result;
  } catch {
    return { ok: false, reason: "database" };
  }
}

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
