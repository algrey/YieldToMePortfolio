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
//
// BRK-016: `createSharesightIntegrationConfig` used to build a brand-new
// `createSharesightTokenProvider` on every call, so every entry point that
// resolves the integration per-invocation (both Sharesight crons in
// `worker/scheduled-refresh.ts`, the per-page gate in
// `app/sharesight-price-gate-service.ts`, and the three actions in
// `app/sharesight-sync-service.ts`) paid a fresh OAuth token exchange before
// every data GET, even when nothing about the credentials had changed. The
// module-scope memo below (`cachedTokenProviderSlot` /
// `memoizedTokenProvider`) keeps ONE provider alive per isolate for the real
// production path (no injected `dependencies`), so a warm isolate reuses the
// provider's own in-closure access-token cache across calls instead of
// re-exchanging every time. See that memo's doc comment for the isolate-
// eviction/security discussion.

import {
  createSharesightClient,
  createSharesightTokenProvider,
  type SharesightClient,
  type SharesightFetcher,
  type SharesightTokenProvider,
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

// BRK-016: module-scope memo for the token provider, ONLY consulted when a
// caller passes NO `dependencies` (production callers -- every real entry
// point, `worker/scheduled-refresh.ts`'s two crons,
// `app/sharesight-price-gate-service.ts`'s per-page gate, and
// `app/sharesight-sync-service.ts`'s three actions -- calls
// `createSharesightIntegrationConfig(env)` with a single argument). A caller
// that injects `dependencies` (a fake `fetcher`/`now`) always bypasses this
// slot entirely -- see the `dependencies` branch below, which never reads or
// writes it -- so that shape is always safe regardless of memo state.
// A NO-`dependencies` test call is NOT automatically safe: it is eligible
// for the memo exactly like production code, and is only correct when the
// test stubs `globalThis.fetch` BEFORE constructing the config (the real
// provider binds `fetch.bind(globalThis)` at construction time) and resets
// this slot via `__resetSharesightIntegrationCacheForTests` in a `finally`.
// Skip either step and the test either reuses a provider bound to a dead
// stub from an earlier case, or its real `fetch` call reaches the network.
//
// Holds AT MOST ONE provider, matched by strict-equality comparison against
// the (clientId, clientSecret) pair that built it -- never a hash/digest of
// either secret (nothing derived from them is ever computed, logged, or
// otherwise observable), and this slot itself is never exported. A changed
// pair simply replaces the slot with a fresh provider built for the new
// credentials; there is no eviction policy beyond "one slot, LRU-of-one."
//
// The actual access token lives ONLY inside the provider's own in-closure
// cache (`domain/sharesight/token.ts`) -- this slot's entire job is keeping
// the SAME provider instance (and therefore that cache) alive across
// repeated `createSharesightIntegrationConfig(env)` calls within one
// Worker isolate, so a cron tick / page load / sync that reuses an
// already-warm isolate skips the OAuth exchange entirely. A Cloudflare
// Workers isolate can be evicted (and this slot along with it) at any time
// for reasons outside this module's control -- that is harmless by design:
// the next call in a fresh isolate simply finds an empty slot, builds a new
// provider, and re-exchanges for a token on first use. The token is never
// written to D1, never logged, and never persists beyond isolate memory.
let cachedTokenProviderSlot: {
  clientId: string;
  clientSecret: string;
  provider: SharesightTokenProvider;
} | null = null;

function memoizedTokenProvider(
  clientId: string,
  clientSecret: string,
): SharesightTokenProvider {
  if (
    cachedTokenProviderSlot &&
    cachedTokenProviderSlot.clientId === clientId &&
    cachedTokenProviderSlot.clientSecret === clientSecret
  ) {
    return cachedTokenProviderSlot.provider;
  }
  const provider = createSharesightTokenProvider({
    clientId,
    clientSecret,
    grantType: "client_credentials",
  });
  cachedTokenProviderSlot = { clientId, clientSecret, provider };
  return provider;
}

/**
 * BRK-016 test-only seam: clears the module-scope memo so test cases don't
 * leak a cached provider (and therefore its cached access token) into one
 * another. Never called from production code -- there is no production
 * reason to evict the slot early, since a stale/failed token is instead
 * handled by `invalidate()` (see `domain/sharesight/client.ts`'s 401
 * mapping) and isolate eviction handles the rest.
 */
export function __resetSharesightIntegrationCacheForTests(): void {
  cachedTokenProviderSlot = null;
}

/**
 * Builds the sealed Sharesight client + `client_credentials` token provider
 * from Worker env, or returns a typed disabled state. Never throws for
 * absent/incomplete configuration -- the only way this can throw is a bug in
 * `domain/sharesight/` itself (e.g. the hardcoded default token URL failing
 * its own shape validation), which would be a genuine programming error, not
 * a runtime configuration state this factory is responsible for handling
 * gracefully.
 *
 * BRK-016: when `dependencies` is omitted (every real production call site),
 * the token provider is reused across calls within the same isolate via
 * `memoizedTokenProvider` above -- a fresh client is still built every call
 * (cheap: it holds no state of its own beyond the shared provider
 * reference), but it wraps the SAME provider, so its access-token cache
 * survives. Passing `dependencies` (every test) always builds a brand-new,
 * unmemoized provider, exactly as before this change.
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

  // BRK-016: memoize ONLY the real production path (no injected
  // `dependencies`) -- see `memoizedTokenProvider`'s doc comment. A caller
  // that injects `dependencies` (every test) always gets a brand-new
  // provider built with its own fetcher/clock, exactly as before this
  // change, so fixtures never share state through this module-scope slot.
  const tokenProvider = dependencies
    ? createSharesightTokenProvider({
        clientId,
        clientSecret,
        grantType: "client_credentials",
        fetcher: dependencies.fetcher,
        now: dependencies.now,
      })
    : memoizedTokenProvider(clientId, clientSecret);

  const client = createSharesightClient({
    tokenProvider,
    fetcher: dependencies?.fetcher,
  });

  return { enabled: true, client };
}
