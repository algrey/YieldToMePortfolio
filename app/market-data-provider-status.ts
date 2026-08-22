// MKT-014: whether this deployment's `MARKET_DATA_PROVIDER` activation gate
// is switched on, so the per-holding "Refresh market data" control
// (`app/components/holding-detail.tsx`) can render an honest
// disabled-deployment message up front instead of silently queuing a
// `market_data_refresh_jobs` row that `worker/scheduled-refresh.ts` will
// never process -- it early-returns whenever
// `runtimeConfig.config.marketDataProvider === "disabled"` (see that
// module's cron/backfill entry points). `requestMarketDataRefreshForContext`
// (`app/market-data-actions.ts`) itself is deliberately left untouched by
// MKT-014: it only enqueues a DB row and has never needed a live provider to
// do that, so this check stays a separate, additive read used purely for
// display, not a new precondition on the existing producer/action.
//
// Mirrors `resolveConfiguredProvider`'s own `cloudflare:workers`/
// `resolveRuntimeConfig` read (`app/security-verification-service.ts`),
// including its fail-closed behaviour on ANY runtime-config error (not just
// an explicitly disabled provider) -- but stops short of constructing a live
// `MarketDataProvider` adapter, since callers here only need the boolean
// gate. Falls closed (disabled) outside a Worker runtime (e.g. `node --test`,
// where `cloudflare:workers` does not resolve), matching every other
// MARKET_DATA_PROVIDER-gated path in this codebase.
import {
  resolveRuntimeConfig,
  type RuntimeEnvInput,
} from "../worker/runtime-config.ts";

export async function marketDataProviderEnabled(): Promise<boolean> {
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeConfig = resolveRuntimeConfig(env as RuntimeEnvInput);
    return (
      runtimeConfig.ok && runtimeConfig.config.marketDataProvider !== "disabled"
    );
  } catch {
    return false;
  }
}
