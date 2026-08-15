// BRK-004: server-only factory that builds a real Sharesight client from
// Worker env, following `worker/runtime-config.ts`'s optional-env
// convention for `CLOUDFLARE_ACCESS_*`: the integration's env input is its
// own local type (`SharesightConfigEnvInput`), decoupled from the generated
// ambient Cloudflare `Env`, so this module compiles without a
// `worker-configuration.d.ts`/`wrangler.json` change -- BRK-005 (which
// actually wires this into a route/cron) is the natural place to add the
// binding declaration once there's a real consumer.
//
// Absent `SHARESIGHT_CLIENT_ID`/`SHARESIGHT_CLIENT_SECRET` means the
// integration is DISABLED -- a typed state (`{ enabled: false }`), never a
// thrown error -- so the rest of the Worker can check `.enabled` and skip
// Sharesight entirely when the owner has not configured it. A HALF
// configured pair (one secret present, the other missing) is also treated
// as disabled, with a distinct `reason`, rather than guessing which secret
// to trust or silently proceeding with an incomplete credential.
//
// BRK-004 carry-over (BRK-003/BRK-008 hardening review, recorded in
// TASKS.md): the host-pinning override escape hatch on both
// `domain/sharesight/token.ts` and `domain/sharesight/client.ts` (documented
// there as BRK-008 spike/local-mock tooling ONLY), and either module's
// caller-overridable endpoint-URL option, must NEVER be plumbed from
// env/config into the real Worker wiring -- this factory hardcodes
// Sharesight's real endpoints via those modules' own defaults and passes
// neither option to either constructor call below. `tests/brk-004.test.ts`
// greps this file's SOURCE TEXT for the exact override option names (kept
// OUT of this comment deliberately, so the grep has nothing benign to match
// against) so a future edit that reintroduces one of them fails that test
// rather than silently reappearing.

import {
  createSharesightClient,
  createSharesightTokenProvider,
  type SharesightClient,
  type SharesightFetcher,
} from "../domain/sharesight/index.ts";

export type SharesightConfigEnvInput = Readonly<{
  SHARESIGHT_CLIENT_ID?: unknown;
  SHARESIGHT_CLIENT_SECRET?: unknown;
}>;

export type SharesightIntegrationDependencies = Readonly<{
  /** Test-only seam; production callers never pass this -- the client/token
   * modules default to the real `fetch`. Never a way to smuggle a
   * host/URL override -- see the module doc above. */
  fetcher?: SharesightFetcher;
  now?: () => number;
}>;

export type SharesightIntegrationConfig =
  | Readonly<{
      enabled: false;
      reason: "not_configured" | "incomplete_configuration";
    }>
  | Readonly<{ enabled: true; client: SharesightClient }>;

function normalizeSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Builds the sealed Sharesight client + `client_credentials` token provider
 * from Worker env, or returns a typed disabled state. Never throws for
 * absent/incomplete configuration -- the only way this can throw is a bug in
 * `domain/sharesight/` itself (e.g. the hardcoded default token URL failing
 * its own shape validation), which would be a genuine programming error, not
 * a runtime configuration state this factory is responsible for handling
 * gracefully.
 */
export function createSharesightIntegrationConfig(
  env: SharesightConfigEnvInput,
  dependencies?: SharesightIntegrationDependencies,
): SharesightIntegrationConfig {
  const clientId = normalizeSecret(env.SHARESIGHT_CLIENT_ID);
  const clientSecret = normalizeSecret(env.SHARESIGHT_CLIENT_SECRET);

  if (clientId === null && clientSecret === null) {
    return { enabled: false, reason: "not_configured" };
  }
  if (clientId === null || clientSecret === null) {
    return { enabled: false, reason: "incomplete_configuration" };
  }

  const tokenProvider = createSharesightTokenProvider({
    clientId,
    clientSecret,
    grantType: "client_credentials",
    fetcher: dependencies?.fetcher,
    now: dependencies?.now,
  });

  const client = createSharesightClient({
    tokenProvider,
    fetcher: dependencies?.fetcher,
  });

  return { enabled: true, client };
}
