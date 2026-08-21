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
import {
  runDailyPriceCapture,
  type RollupFailureKind,
} from "../app/daily-price-capture-service.ts";
import { createSharesightIntegrationConfig } from "./sharesight-config.ts";
import { createYahooAuthConfig } from "./yahoo-auth-config.ts";

const CORPORATE_ACTION_PROVIDER_ID = "yahoo-compatible";

export type ScheduledRefreshResult =
  | { ok: true; skipped: boolean; jobs: number; providerRequests: number }
  | { ok: false; reason: "configuration" | "database" | "refresh" };

function resolveYahooProviderSymbol(
  client: Awaited<ReturnType<typeof getSqlClient>>,
) {
  return async (mappingId: string) => {
    const mapping = await client.get<{ provider_symbol: string }>(
      `SELECT provider_symbol FROM security_provider_mappings
       WHERE id = ? AND provider_id = 'yahoo-compatible'
         AND status = 'verified' LIMIT 1`,
      [mappingId],
    );
    return mapping?.provider_symbol ?? null;
  };
}

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
    resolveSymbol: resolveYahooProviderSymbol(client),
  });
}

/**
 * MKT-011A: two DISTINCT provider instances, mirroring MKT-009B's read-path
 * preference semantics (`combineScopedPriceSelections`) for the write side --
 * `yahoo_authenticated` owners get the login-cookie jar attached when
 * configured (the adapter still gracefully degrades per-request on a 401,
 * same as every other authenticated call site); `yahoo_anonymous` owners
 * NEVER get the cookie jar, even when the deployment has one configured,
 * since that owner explicitly opted out of the authenticated session.
 * Building an adapter instance is a pure closure (no request happens until a
 * capability method is actually called), so constructing both unconditionally
 * costs nothing when a deployment has zero yahoo-source owners.
 */
function buildYahooCaptureProviders(
  client: Awaited<ReturnType<typeof getSqlClient>>,
  env: Env,
) {
  const authConfig = createYahooAuthConfig(
    env as unknown as Parameters<typeof createYahooAuthConfig>[0],
  );
  const resolveSymbol = resolveYahooProviderSymbol(client);
  return {
    yahooAuthenticatedProvider: createYahooCompatibleProvider({
      providerId: CORPORATE_ACTION_PROVIDER_ID,
      fetcher: fetch,
      auth: authConfig.enabled ? authConfig.credentials : null,
      resolveSymbol,
    }),
    yahooAnonymousProvider: createYahooCompatibleProvider({
      providerId: CORPORATE_ACTION_PROVIDER_ID,
      fetcher: fetch,
      auth: null,
      resolveSymbol,
    }),
  };
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

export type ScheduledDailyPriceCaptureResult =
  | {
      ok: true;
      usersProcessed: number;
      sharesightRequests: number;
      yahooRequests: number;
      intradayPointsCaptured: number;
      rolledUp: number;
      purged: number;
      skippedNoMapping: number;
      /** Review round B3: nonzero means a rollup pair genuinely THREW this
       * tick (never the honest `no_mapping` outcome, already counted via
       * `skippedNoMapping`) -- `worker/index.ts` logs a degraded (non-
       * "success") result when this is nonzero, so a wedged pipeline stays
       * operationally visible instead of reading as a routine success. */
      rollupsFailed: number;
      /** Free-text diagnostic -- kept on this result for callers/tests that
       * want it, but `worker/index.ts`'s structured log emits ONLY
       * `firstRollupErrorKind` (review round F5). */
      firstRollupError: string | null;
      firstRollupErrorKind: RollupFailureKind | null;
    }
  | { ok: false; reason: "database" };

/**
 * MKT-011A trigger: the intraday-capture/rollup sweep, fired by the SECOND
 * cron pattern (`25,55 * * * *`, `wrangler.json`'s `triggers.crons`) --
 * distinct from every other scheduled job in this file, which all run on
 * the existing `0 * * * *` pattern. `worker/index.ts`'s `scheduled` handler
 * dispatches on `controller.cron` to call this ONLY for the intraday
 * pattern, never on the hourly tick (see that handler's own comment).
 *
 * `isSecondaryTick` is derived from the ACTUAL fired minute
 * (`controller.scheduledTime`), not merely "this is the second cron
 * pattern": both `:25` and `:55` share the SAME pattern string, so the
 * handler must look at the real fire time to know which slot this is (see
 * `app/daily-price-capture-service.ts`'s cadence-gating doc comment).
 * Builds the Sharesight client (optional, BRK-012B/012C precedent)
 * unconditionally -- Sharesight capture has no `MARKET_DATA_PROVIDER`
 * dependency (BRK-012B/012C precedent). Yahoo capture, by contrast, DOES
 * respect that deployment-wide kill switch: when
 * `resolveRuntimeConfig(env).config.marketDataProvider === 'disabled'`, both
 * Yahoo provider instances are passed as `null` (never constructed), so a
 * `yahoo_authenticated`/`yahoo_anonymous` capture setting can never bypass
 * the same gate MKT-009B's read-path preference already respects.
 */
export async function runScheduledDailyPriceCapture(
  env: Env,
  options: Readonly<{ isSecondaryTick: boolean }>,
): Promise<ScheduledDailyPriceCaptureResult> {
  try {
    const client = await getSqlClient();
    const integration = createSharesightIntegrationConfig(
      env as unknown as Parameters<typeof createSharesightIntegrationConfig>[0],
    );
    const runtimeConfig = resolveRuntimeConfig(env);
    const yahooEnabled =
      runtimeConfig.ok &&
      runtimeConfig.config.marketDataProvider !== "disabled";
    const { yahooAuthenticatedProvider, yahooAnonymousProvider } = yahooEnabled
      ? buildYahooCaptureProviders(client, env)
      : { yahooAuthenticatedProvider: null, yahooAnonymousProvider: null };
    const result = await runDailyPriceCapture({
      client,
      sharesightClient: integration.enabled ? integration.client : null,
      yahooAuthenticatedProvider,
      yahooAnonymousProvider,
      isSecondaryTick: options.isSecondaryTick,
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
