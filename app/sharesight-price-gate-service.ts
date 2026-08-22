// BRK-012C: the 10-minute delayed-price read gate. Runs inline on the
// authenticated holdings read path (`app/owned-holdings.ts`'s single choke
// point, mirroring CALC-003's read-time self-heal pattern) so a portfolio
// page load never displays a Sharesight price older than 10 minutes without
// first trying, ONCE, to refresh it.
//
// Design (see db/schema.ts's `sharesightDelayedPrices` comment for the full
// rationale): this module's OWN write is a cache-freshness upsert into
// `sharesight_delayed_prices`; it deliberately ALSO piggybacks the SAME
// `price_observations` accretion write BRK-012B's hourly cron already makes
// (`db/repositories/sharesight-price-refresh.ts`'s
// `upsertSharesightPriceObservations`), reusing the identical pure
// plan-builder (`buildSharesightPriceAccretionPlan`) so both writes are
// derived from ONE `listUserInstruments()` call and stay in lockstep. This
// is what keeps `price_observations` -- which is what `owned-holdings.ts`'s
// existing selection machinery actually reads for display -- bounded to at
// most ~10 minutes stale whenever a portfolio is actively loaded; the
// hourly cron remains the honest outer bound when nobody is looking. There
// is ONE selection implementation (`domain/market-data/selection.ts`, wired
// through `app/owned-holdings.ts`'s single `loadOwnedHoldings`); THREE call
// sites reach it (`app/owned-holdings.ts` itself, `app/owned-income-
// projection.ts`, `app/owned-dividend-assumptions.ts`) can each trigger this
// gate independently within the same short window, but the watermark below
// (not "only one call site exists") is what keeps that to at most one real
// Sharesight fetch -- the gate is idempotent by construction, not by
// accident of call-graph shape.
//
// Review round (2026-08-20, BLOCKING, all three fixed here):
//   B1: staleness was computed PER-SECURITY off the cache table -- a held
//   security Sharesight never matches (no `sharesight_instrument` identifier)
//   can NEVER have a cache row, so that check reported "stale" on EVERY
//   load of a mixed portfolio, defeating the whole 10-minute window (only
//   the single-flight lease, 2 minutes, bounded the damage). FIX: staleness
//   is now a PER-OWNER fact -- one `listUserInstruments()` call refreshes
//   everything fetchable for this owner in one shot, so the gate reads a
//   single per-owner watermark (`sharesight_sync_state.last_price_refresh_at`
//   -- see below for why this REUSES BRK-012B's existing cron watermark
//   rather than adding a duplicate column) instead of a per-security cache
//   scan. The cache table itself is unchanged in shape/purpose (still one
//   row per security, still the audit/freshness-display store per db/
//   schema.ts) -- a held-but-unmatched security simply never gets a cache
//   row, and its price stays whatever `price_observations` already offers
//   (or "Price unavailable"), exactly as documented; that's not a defect,
//   it's the honest consequence of Sharesight never having sent that
//   instrument.
//   B2: `loadSharesightDelayedPriceCache`'s `IN (...)` clause scaled
//   unbounded with the held-security count (up to `MAX_HELD` = 500 bind
//   params in ONE statement) -- fixed by chunking it (`db/repositories/
//   sharesight-delayed-price-cache.ts`, `<=50` ids/chunk). That function is
//   no longer on this gate's hot path after the B1 fix (the staleness
//   decision is now the single-row watermark read below), but it remains
//   exported/used for cache reads, so the chunking is a real fix, not
//   dead-code busywork.
//   B3: a cross-basis daily-movement comparison (see `app/owned-
//   holdings.ts`'s `dailyUnavailableReason`) is a SEPARATE, unrelated fix
//   in the same review round -- documented there, not here.
//
// MKT-015 (2026-08-22): day-change went dark on any day nobody opened the
// app AND no cron tick landed for it -- cron never fires at all in local
// dev (`wrangler dev` delivers no scheduled events by default), and even
// in production a cron sweep can simply miss the narrow window before
// Sharesight's own feed rolls its `current_price` over to the next trading
// day. `refreshAndCache` below now reads the delayed-price cache's
// PRE-refresh row for every matched security before overwriting it, and
// backfills any market date it still evidences that never made it into
// `price_observations` -- see `buildSharesightPriceGateBackfillCandidates`
// (domain/sharesight/price-accretion.ts) for the honesty/idempotency rules
// this must follow (never fabricate a date Sharesight didn't quote; only
// the SINGLE still-cached prior date recovers, never anything guessed
// between it and today).
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  claimSharesightPriceGateLease,
  hasEnabledSharesightLink,
  loadSharesightDelayedPriceCache,
  releaseSharesightPriceGateLease,
  upsertSharesightDelayedPriceCache,
} from "../db/repositories/sharesight-delayed-price-cache.ts";
import {
  loadSharesightPriceRefreshWatermark,
  recordSharesightPriceRefreshWatermark,
  resolveScopedSharesightInstrumentSecurities,
  upsertSharesightPriceObservations,
} from "../db/repositories/sharesight-price-refresh.ts";
import {
  buildSharesightPriceAccretionPlan,
  buildSharesightPriceGateBackfillCandidates,
  type SharesightClient,
} from "../domain/sharesight/index.ts";
import {
  createSharesightIntegrationConfig,
  type SharesightIntegrationConfig,
} from "../worker/sharesight-config.ts";

/** The ruling's exact boundary: 9m59s is watermark-fresh, 10m01s refreshes. */
export const SHARESIGHT_PRICE_GATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Long enough that one refresh (a single `listUserInstruments()` call plus
 * two small bounded batch writes -- comfortably under BRK-012B's own
 * measured per-chunk cost) never races its own expiry; short enough that a
 * crashed/abandoned request's lease does not block every other load for
 * this owner for anywhere near the full 10-minute cache window.
 */
export const SHARESIGHT_PRICE_GATE_LEASE_DURATION_MS = 2 * 60 * 1000;

export type SharesightPriceGateOptions = Readonly<{
  /** Test-only seam: an already-resolved integration config (skips the
   * `cloudflare:workers` env import a plain node:sqlite test cannot use) --
   * mirrors `app/sharesight-sync-service.ts`'s identical seam. */
  integration?: SharesightIntegrationConfig;
  now?: () => string;
  /** Test-only seam for deterministic single-flight drills. */
  leaseOwner?: () => string;
  maxAgeMs?: number;
  leaseDurationMs?: number;
}>;

export type SharesightPriceGateResult =
  | { ok: true; action: "cache_fresh" }
  | { ok: true; action: "not_configured" }
  | { ok: true; action: "not_linked" }
  | { ok: true; action: "no_holdings" }
  | { ok: true; action: "lease_contended" }
  | {
      ok: true;
      action: "refreshed";
      matchedCount: number;
      cacheWritten: number;
      observationsWritten: number;
    }
  | { ok: false; action: "fetch_failed"; errorKind: string };

async function resolveIntegration(
  options: SharesightPriceGateOptions,
): Promise<SharesightIntegrationConfig> {
  if (options.integration) return options.integration;
  try {
    const { env } = await import("cloudflare:workers");
    return createSharesightIntegrationConfig(
      env as unknown as Parameters<typeof createSharesightIntegrationConfig>[0],
    );
  } catch {
    return { enabled: false, reason: "not_configured" };
  }
}

/**
 * Pure boundary check, exported for direct unit testing of the 9m59s/10m01s
 * edge. `null` (no attempt has ever been recorded for this owner) is always
 * stale. A NON-FINITE stored/now value fails closed as stale rather than
 * silently treating garbage as fresh.
 */
export function isSharesightPriceWatermarkStale(
  lastAttemptAt: string | null,
  nowIso: string,
  maxAgeMs: number,
): boolean {
  if (lastAttemptAt === null) return true;
  const lastMs = Date.parse(lastAttemptAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - lastMs > maxAgeMs;
}

/**
 * Ensures this owner's Sharesight price data (`price_observations`, read by
 * the existing selection machinery, plus the `sharesight_delayed_prices`
 * audit cache) is fresh enough to serve their CURRENT holdings before
 * `app/owned-holdings.ts` reads prices. Never throws for ordinary gate
 * outcomes -- see the module doc comment; a genuine DB error during the
 * write phase still propagates (the caller's `.catch()` handles it exactly
 * like every other best-effort read-time self-heal in this codebase).
 */
export async function ensureSharesightPriceFreshness(
  client: SqlClient,
  userId: string,
  heldSecurityIds: readonly string[],
  options: SharesightPriceGateOptions = {},
): Promise<SharesightPriceGateResult> {
  if (heldSecurityIds.length === 0) return { ok: true, action: "no_holdings" };

  const now = options.now ?? (() => new Date().toISOString());
  const nowLeaseOwner = options.leaseOwner ?? (() => crypto.randomUUID());
  const maxAgeMs = options.maxAgeMs ?? SHARESIGHT_PRICE_GATE_MAX_AGE_MS;
  const leaseDurationMs =
    options.leaseDurationMs ?? SHARESIGHT_PRICE_GATE_LEASE_DURATION_MS;

  // Gate 1: credentials configured at all -- zero DB reads when not.
  const integration = await resolveIntegration(options);
  if (!integration.enabled) return { ok: true, action: "not_configured" };

  // Gate 2: this owner has an enabled link -- one EXISTS query.
  if (!(await hasEnabledSharesightLink(client, userId))) {
    return { ok: true, action: "not_linked" };
  }

  // Gate 3 (review round B1 fix): PER-OWNER attempt watermark, not a
  // per-security cache scan. Reuses `sharesight_sync_state.last_price_
  // refresh_at`/`_status`/`_error_kind` -- the SAME row BRK-012B's hourly
  // cron already stamps on every attempt for this owner -- rather than a
  // second, duplicate "gate attempt" column set: both the cron and this
  // gate represent the IDENTICAL fact ("when did we last attempt a
  // Sharesight price fetch for this owner, and did it succeed"), and the
  // watermark already lives on the same row the lease columns do. Reusing
  // it means an hourly cron run automatically "resets the gate clock" for
  // free (review follow-up 2) -- the very next load after a cron sweep sees
  // a fresh watermark and serves cache/`price_observations` with zero
  // Sharesight calls, with no separate column to keep in sync.
  const nowIso = now();
  const watermark = await loadSharesightPriceRefreshWatermark(client, userId);
  if (!isSharesightPriceWatermarkStale(watermark, nowIso, maxAgeMs)) {
    return { ok: true, action: "cache_fresh" };
  }

  // Gate 4: single-flight lease -- a losing concurrent request serves
  // whatever is already there rather than double-fetching.
  const leaseOwner = nowLeaseOwner();
  const claimed = await claimSharesightPriceGateLease(client, {
    userId,
    leaseOwner,
    now: nowIso,
    leaseDurationMs,
  });
  if (!claimed) return { ok: true, action: "lease_contended" };

  try {
    return await refreshAndCache(client, integration.client, userId, nowIso);
  } finally {
    // Always release, success or failure -- see this function's release
    // helper doc comment for why this is safe/idempotent and why an
    // unreleased lease is only ever a bounded delay, never a correctness
    // problem.
    await releaseSharesightPriceGateLease(client, {
      userId,
      leaseOwner,
      now: now(),
    }).catch(() => undefined);
  }
}

async function refreshAndCache(
  client: SqlClient,
  sharesightClient: SharesightClient,
  userId: string,
  nowIso: string,
): Promise<SharesightPriceGateResult> {
  const result = await sharesightClient.listUserInstruments();
  if (!result.ok) {
    // Review round B2 fix (folding reviewer follow-up 1): the failure is
    // now RECORDED, not merely swallowed by the caller's outer catch -- a
    // failed attempt still stamps the watermark (status='failed' +
    // errorKind), which is exactly what holds the 10-minute window closed
    // so a persistently broken fetch cannot be retried on every render (the
    // ruling's "a broken fetch can't hammer Sharesight every render").
    // Best-effort: if the watermark write itself also fails, that must
    // never mask the real fetch failure being reported to the caller.
    await recordSharesightPriceRefreshWatermark(client, {
      userId,
      status: "failed",
      errorKind: result.error.kind,
      now: nowIso,
    }).catch(() => undefined);
    // Stale-serve-on-failure: no cache/observation write happens, so
    // whatever was already there (however old) keeps serving, honestly --
    // this function never fabricates a fresher row than what was actually
    // fetched.
    return { ok: false, action: "fetch_failed", errorKind: result.error.kind };
  }

  const scopeMap = await resolveScopedSharesightInstrumentSecurities(
    client,
    userId,
  );
  const plan = buildSharesightPriceAccretionPlan(result.value, scopeMap);

  // MKT-015 (ordering fix): read the PRE-refresh cache for exactly the
  // securities this fetch just matched BEFORE anything below overwrites
  // it -- this is the LAST moment a market date that rolled over since the
  // cache was last written (e.g. an owner who never opened the app across
  // a whole weekend, with no cron in local dev to have caught it either)
  // is still recoverable anywhere. See
  // `buildSharesightPriceGateBackfillCandidates`'s doc comment
  // (domain/sharesight/price-accretion.ts) for the full honesty/idempotency
  // rules. Bounded by the SAME chunked read `loadSharesightDelayedPriceCache`
  // already uses elsewhere (BRK-012C review B2 fix) -- no new unbounded
  // query.
  const previousCache = await loadSharesightDelayedPriceCache(
    client,
    userId,
    plan.candidates.map((candidate) => candidate.securityId),
  );
  const backfillCandidates = buildSharesightPriceGateBackfillCandidates(
    plan.candidates,
    previousCache,
  );

  // Sequential, not `Promise.all` -- both writes share the SAME `client`,
  // and this codebase's other multi-batch write paths (e.g. BRK-012B's
  // per-user loop in `sharesight-price-refresh-service.ts`) never issue
  // overlapping concurrent batches against one connection.
  const observationWrite = await upsertSharesightPriceObservations(client, {
    userId,
    candidates: plan.candidates,
    now: nowIso,
  });
  // MKT-015: the backfill write, if any -- SAME idempotent upsert path
  // (`price_observations_provider_scope_mapping_date_unique`) as the fresh
  // write above, just a different `market_date` per candidate, so this can
  // never collide with or duplicate the fresh write. Zero candidates (the
  // overwhelming common case: no day rolled over since the cache was last
  // written) costs zero extra statements.
  const backfillWrite =
    backfillCandidates.length > 0
      ? await upsertSharesightPriceObservations(client, {
          userId,
          candidates: backfillCandidates,
          now: nowIso,
          // MKT-015 review round B3 (BLOCKING): a backfill candidate is
          // built from a cache snapshot that may be hours/days stale --
          // never let it downgrade an already-fresher price_observations
          // row for that SAME prior day (e.g. one the hourly cron wrote
          // independently, more recently than this gate's own cache read).
          // The ordinary fresh-day write above deliberately does NOT pass
          // this -- see `upsertSharesightPriceObservations`'s doc comment.
          noDowngrade: true,
        })
      : { written: 0 };
  const cacheWrite = await upsertSharesightDelayedPriceCache(client, {
    userId,
    candidates: plan.candidates,
    now: nowIso,
  });
  // Success stamps the SAME shared watermark -- see the Gate 3 comment
  // above for why this is deliberately the cron's own field, not a
  // duplicate. Best-effort (mirrors BRK-012B's own watermark-write
  // resilience): a failure here must not discard the writes that already
  // committed above.
  await recordSharesightPriceRefreshWatermark(client, {
    userId,
    status: "ok",
    errorKind: null,
    now: nowIso,
  }).catch(() => undefined);

  return {
    ok: true,
    action: "refreshed",
    matchedCount: plan.matchedCount,
    cacheWritten: cacheWrite.written,
    // MKT-015: includes any backfilled prior-day row(s) -- kept as ONE
    // combined total (not a new result field) since both writes go to the
    // SAME `price_observations` table via the SAME idempotent upsert; the
    // common zero-backfill case leaves this byte-identical to before.
    observationsWritten: observationWrite.written + backfillWrite.written,
  };
}
