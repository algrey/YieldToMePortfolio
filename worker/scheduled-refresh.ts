import { createMarketDataRefreshRepository } from "../db/repositories/market-data-refresh.ts";
import { getSqlClient } from "../db/d1-sql-client.ts";
import {
  createMarketDataRefreshService,
  createYahooCompatibleProvider,
  runDueCorporateActionRefresh,
} from "../domain/market-data/index.ts";
import { resolveRuntimeConfig } from "./runtime-config.ts";

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
