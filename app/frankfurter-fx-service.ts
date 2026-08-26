// MKT-021: resolves the Frankfurter FX-rate client the same way
// `app/security-verification-service.ts`'s `resolveConfiguredProvider`
// resolves the Yahoo-compatible provider -- an `import("cloudflare:workers")`
// probe that throws under `node --test` (no Worker runtime), so tests never
// make a real network call unless they explicitly inject a client via an
// action's own options parameter. Frankfurter needs no credentials/env
// config (it is a free, no-API-key public feed), so there is no equivalent
// of Yahoo's `MARKET_DATA_PROVIDER`/cookie-jar configuration here -- the
// only gate is the `market_data_providers` row's own `status` column
// (mirrors `app/watchlist-actions.ts`'s existing `providerEnabled` check for
// the Yahoo-compatible search path), so an operator can still disable this
// provider deployment-wide without a redeploy.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  createFrankfurterFxClient,
  FRANKFURTER_PROVIDER_ID,
  type FrankfurterFxClient,
} from "../domain/market-data/index.ts";
import type { MarketDataError } from "../domain/market-data/index.ts";

// MKT-005 review's `BOUNDED_CORPORATE_ACTION_PROVIDER_OPTIONS` precedent
// (`app/security-verification-service.ts`): a best-effort follow-up fetch
// after a user-facing mutation already succeeded must stay short -- a
// single attempt at a few seconds' timeout, never "eventually catches its
// own failure" at the cost of tens of seconds of added latency on the
// owner's add-to-watchlist click.
export const BOUNDED_FRANKFURTER_PRIME_OPTIONS = {
  maxAttempts: 1,
  timeoutMs: 3_000,
};

function disabledFrankfurterFxClient(): FrankfurterFxClient {
  return {
    getLatestRate: async () => ({
      ok: false,
      error: {
        kind: "unavailable_capability",
        message: "Frankfurter FX rates are unavailable in this runtime.",
        retryable: false,
      } satisfies MarketDataError,
    }),
  };
}

export async function frankfurterProviderEnabled(
  client: SqlClient,
): Promise<boolean> {
  const providerRow = await client.get<{ status: string }>(
    `SELECT status FROM market_data_providers WHERE id = ? LIMIT 1`,
    [FRANKFURTER_PROVIDER_ID],
  );
  return Boolean(providerRow) && providerRow!.status === "enabled";
}

export async function resolveFrankfurterFxClient(): Promise<FrankfurterFxClient> {
  try {
    // Presence of the Worker runtime, not any specific env var, is the
    // signal here -- Frankfurter needs no configuration to enable, only a
    // real `fetch` reaching the public internet, which `node --test` has no
    // business doing implicitly.
    await import("cloudflare:workers");
    return createFrankfurterFxClient({
      fetcher: fetch,
      ...BOUNDED_FRANKFURTER_PRIME_OPTIONS,
    });
  } catch {
    return disabledFrankfurterFxClient();
  }
}
