import { createMarketDataRefreshRepository } from "../db/repositories/market-data-refresh.ts";
import { getSqlClient } from "../db/d1-sql-client.ts";
import { createMarketDataRefreshService } from "../domain/market-data/ingestion.ts";
import { createYahooCompatibleProvider } from "../domain/market-data/index.ts";
import { resolveRuntimeConfig } from "./runtime-config.ts";

export type ScheduledRefreshResult =
  | { ok: true; skipped: boolean; jobs: number; providerRequests: number }
  | { ok: false; reason: "configuration" | "database" | "refresh" };

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
    const provider = createYahooCompatibleProvider({
      providerId: "yahoo-compatible",
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
