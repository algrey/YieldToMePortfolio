import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  DAILY_CAPTURE_LIMITS,
  guardInsertSharesightMapping,
  insertIntradayPricePoint,
  purgeIntradayPricePoints,
  resolveDailyCaptureRollupCandidates,
  resolveDailyCaptureUserSettings,
  resolveScopedYahooCaptureSecurities,
  resolveSecurityMarketTimezones,
  rollupIntradayPricePoint,
  selectLastIntradayPricePoint,
  YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
  type DailyCaptureSource,
  type DailyCaptureUserSetting,
} from "../db/repositories/intraday-price-capture.ts";
import {
  listEnabledSharesightUserIds,
  resolveScopedSharesightInstrumentSecurities,
  SHARESIGHT_PRICE_PROVIDER_ID,
} from "../db/repositories/sharesight-price-refresh.ts";
import {
  buildSharesightPriceAccretionPlan,
  type SharesightClient,
} from "../domain/sharesight/index.ts";
import {
  isDailyCaptureRollupEligible,
  resolveDailyCaptureWindowStatus,
} from "../domain/market-data/daily-capture-window.ts";
import type {
  MarketDataProvider,
  ObservationScope,
} from "../domain/market-data/contracts.ts";

// MKT-011A: the daily intraday-price-capture sweep, run every `25,55 * * * *`
// cron tick (`worker/scheduled-refresh.ts`'s `runScheduledDailyPriceCapture`).
// Two phases run every tick, for every configured owner:
//
//   (A) CAPTURE -- for owners whose window is currently open (10:25-16:25
//       local, weekday, per the security's OWN stored market timezone) and
//       whose cadence setting says this tick counts, fetch the latest
//       observation from THIS owner's configured `daily_capture_source` and
//       cache it (`intraday_price_points`), idempotently.
//   (B) ROLLUP+PURGE -- for EVERY configured owner, regardless of whether
//       phase (A) ran for them this tick, promote any (security, market_date)
//       pair whose window has now closed (today, once past 16:25) OR belongs
//       to a PRIOR day (crash/missed-tick recovery -- the owner ruling's
//       "first sweep of a later day rolls up yesterday's last point before
//       purging") into `price_observations`, then purge exactly those
//       cached rows. This is cheap (DB-only, no external request) and safe
//       to run unconditionally every tick.
//
// Per-user failures never abort the sweep for other users -- same isolation
// discipline as `app/sharesight-price-refresh-service.ts`. Phase B goes one
// level finer: each (owner, security, market_date) rollup PAIR runs in its
// own try/catch, so one wedged pair never blocks a later pair for the SAME
// owner in the SAME tick (review round B1/B3) -- a genuine failure is
// counted (`rollupsFailed`/`firstRollupError`), never silently swallowed
// into an `ok:true` summary.

const DEPLOYMENT_SCOPE: ObservationScope = { kind: "deployment", userId: null };

export type DailyPriceCaptureDeps = Readonly<{
  client: SqlClient;
  /** `null` means the Sharesight integration is not configured for this
   * deployment -- mirrors `SharesightPriceRefreshDeps.sharesightClient`. */
  sharesightClient: SharesightClient | null;
  /** Yahoo-compatible provider WITH the login-cookie jar attached when
   * configured (may still behave anonymously per-request if cookies are
   * absent/invalid -- see `yahoo-compatible.ts`) -- used for owners whose
   * `daily_capture_source` is `yahoo_authenticated`. `null` means Yahoo is
   * disabled at the deployment level (`MARKET_DATA_PROVIDER === 'disabled'`,
   * `worker/runtime-config.ts`) -- the SAME deployment-wide kill switch
   * MKT-009B's read-path preference already respects; a `yahoo_authenticated`/
   * `yahoo_anonymous` capture setting never bypasses it. Sharesight capture
   * has no such gate (BRK-012B/012C precedent -- Sharesight is independent
   * of `MARKET_DATA_PROVIDER` entirely). */
  yahooAuthenticatedProvider: MarketDataProvider | null;
  /** Yahoo-compatible provider with NO auth attached, regardless of
   * deployment cookie configuration -- used for `yahoo_anonymous` owners,
   * who explicitly opted OUT of the authenticated session. Same `null`
   * meaning as `yahooAuthenticatedProvider` above. */
  yahooAnonymousProvider: MarketDataProvider | null;
  now?: () => string;
  /** True on the `:55` cron tick -- owners on the 60-minute cadence skip
   * NEW captures this tick (rollup/purge still runs regardless, every
   * tick). */
  isSecondaryTick: boolean;
}>;

export type DailyPriceCaptureSummary =
  | Readonly<{
      ok: true;
      usersProcessed: number;
      sharesightRequests: number;
      yahooRequests: number;
      intradayPointsCaptured: number;
      rolledUp: number;
      purged: number;
      skippedNoMapping: number;
      /** Review round B3: a rollup attempt that THREW (never the honest
       * `{ ok: false, reason: 'no_mapping' }` outcome, which is already
       * counted separately via `skippedNoMapping`) for one (owner, security,
       * market_date) pair -- e.g. a real DB error. Counted per PAIR, not per
       * owner: each candidate now runs in its own try/catch (B1/B3 -- a
       * single wedged pair must never block a LATER pair for the same owner
       * in the same tick, unlike an earlier version of this loop). A
       * nonzero count here means the intraday cache for that pair was
       * deliberately left unpurged for a later retry -- never silently
       * treated as "success". */
      rollupsFailed: number;
      /** The first rollup failure's error message this sweep tick
       * encountered, `null` when `rollupsFailed === 0` -- an operational
       * diagnostic kept on this in-memory summary object for tests/deeper
       * debugging, never a security-sensitive value (DB error messages
       * only, no secrets ever flow through this path). Review round F5:
       * this free-text message is NEVER what reaches the structured worker
       * log -- see `firstRollupErrorKind` below, which is. */
      firstRollupError: string | null;
      /** Review round F5: a CLOSED, bounded classification of
       * `firstRollupError`, mirroring the `SharesightErrorKind`-style
       * closed-reason-enum precedent other scheduled jobs already use
       * (`domain/sharesight/contracts.ts`). `worker/index.ts`'s structured
       * log emits ONLY this enum, never the free-text message -- an
       * unbounded DB error string is not a safe/stable thing to ship into
       * log metadata (message text can vary across D1/sqlite backends and
       * driver versions for the SAME underlying failure, and is not
       * guaranteed secret-free the way a closed enum is by construction).
       * `null` when `rollupsFailed === 0`. */
      firstRollupErrorKind: RollupFailureKind | null;
    }>
  | Readonly<{ ok: false; reason: "database" }>;

/** Review round F5: a closed classification for an uncaught rollup error,
 * derived from the error's own message text -- the `SqlClient` abstraction
 * (`db/repositories/sql-client.ts`) carries no structured error code of its
 * own across both its D1 and node:sqlite backends, so text-matching against
 * each backend's own conventional wording is the only signal available.
 * Best-effort, not exhaustive: an error this heuristic cannot place lands
 * honestly in `"unknown"` rather than being guessed into the wrong bucket. */
export type RollupFailureKind = "constraint" | "network" | "unknown";

export function classifyRollupFailure(error: unknown): RollupFailureKind {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  if (
    message.includes("constraint") ||
    message.includes("unique") ||
    message.includes("foreign key")
  ) {
    return "constraint";
  }
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("econnrefused")
  ) {
    return "network";
  }
  return "unknown";
}

function providerIdForSource(source: DailyCaptureSource): string {
  return source === "sharesight"
    ? SHARESIGHT_PRICE_PROVIDER_ID
    : YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID;
}

/** 60-minute-cadence owners skip the `:55` secondary tick entirely; 30-minute
 * owners capture on every tick. */
function isCaptureTickEligible(
  setting: DailyCaptureUserSetting,
  isSecondaryTick: boolean,
): boolean {
  return !(isSecondaryTick && setting.dailyCaptureIntervalMinutes >= 60);
}

export async function runDailyPriceCapture(
  deps: DailyPriceCaptureDeps,
): Promise<DailyPriceCaptureSummary> {
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    const nowIso = now();
    const settings = await resolveDailyCaptureUserSettings(deps.client);

    let sharesightRequests = 0;
    let yahooRequests = 0;
    let intradayPointsCaptured = 0;
    let rolledUp = 0;
    let purged = 0;
    let skippedNoMapping = 0;
    let yahooBudgetRemaining = DAILY_CAPTURE_LIMITS.maxYahooRequestsPerSweep;

    // ------------------------------------------------------------------
    // Phase A: capture -- Sharesight (one shared fetch, BRK-012B pattern)
    // ------------------------------------------------------------------
    const sharesightCandidates = settings.filter(
      (setting) =>
        setting.dailyCaptureSource === "sharesight" &&
        isCaptureTickEligible(setting, deps.isSecondaryTick),
    );
    if (sharesightCandidates.length > 0 && deps.sharesightClient) {
      const enabledUserIds = new Set(
        await listEnabledSharesightUserIds(deps.client),
      );
      const eligibleUsers = sharesightCandidates.filter((setting) =>
        enabledUserIds.has(setting.userId),
      );
      if (eligibleUsers.length > 0) {
        const result = await deps.sharesightClient.listUserInstruments();
        sharesightRequests += 1;
        if (result.ok) {
          for (const setting of eligibleUsers) {
            try {
              const scopeMap =
                await resolveScopedSharesightInstrumentSecurities(
                  deps.client,
                  setting.userId,
                );
              const plan = buildSharesightPriceAccretionPlan(
                result.value,
                scopeMap,
              );
              if (plan.candidates.length === 0) continue;
              const timezones = await resolveSecurityMarketTimezones(
                deps.client,
                plan.candidates.map((candidate) => candidate.securityId),
              );
              for (const candidate of plan.candidates) {
                const timezone = timezones.get(candidate.securityId) ?? null;
                if (!timezone) continue;
                const windowStatus = resolveDailyCaptureWindowStatus(
                  nowIso,
                  timezone,
                );
                if (!windowStatus) continue;
                if (candidate.marketDate !== windowStatus.localDate) continue;
                if (!windowStatus.isWithinCaptureWindow) continue;
                await guardInsertSharesightMapping(deps.client, {
                  securityId: candidate.securityId,
                  marketCode: candidate.marketCode,
                  instrumentCode: candidate.instrumentCode,
                  now: nowIso,
                });
                const captured = await insertIntradayPricePoint(deps.client, {
                  userId: setting.userId,
                  securityId: candidate.securityId,
                  providerId: SHARESIGHT_PRICE_PROVIDER_ID,
                  priceDecimal: candidate.closeDecimal,
                  currencyCode: candidate.currencyCode,
                  marketDate: candidate.marketDate,
                  marketTimezone: candidate.marketTimezone,
                  observedAt: candidate.observationAt,
                  capturedAt: nowIso,
                  delayedMinutes: null,
                  quality: "observed",
                  providerRevisionId: null,
                });
                if (captured.inserted) intradayPointsCaptured += 1;
              }
            } catch {
              // Per-owner isolation -- one owner's resolve/write failure
              // never blocks another owner's capture this tick (BRK-012B
              // precedent). Rollup/purge (phase B) still runs for this
              // owner below regardless.
            }
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Phase A: capture -- Yahoo-compatible (per-security, budget-bounded)
    // ------------------------------------------------------------------
    const yahooGroups: Array<{
      source: "yahoo_authenticated" | "yahoo_anonymous";
      provider: MarketDataProvider | null;
    }> = [
      {
        source: "yahoo_authenticated",
        provider: deps.yahooAuthenticatedProvider,
      },
      { source: "yahoo_anonymous", provider: deps.yahooAnonymousProvider },
    ];
    for (const group of yahooGroups) {
      // MARKET_DATA_PROVIDER deployment kill switch -- see
      // `yahooAuthenticatedProvider`'s doc comment. Zero requests, zero DB
      // reads for this group entirely when Yahoo is disabled.
      if (!group.provider) continue;
      const provider = group.provider;
      if (yahooBudgetRemaining <= 0) break;
      const eligibleUsers = settings.filter(
        (setting) =>
          setting.dailyCaptureSource === group.source &&
          isCaptureTickEligible(setting, deps.isSecondaryTick),
      );
      for (const setting of eligibleUsers) {
        if (yahooBudgetRemaining <= 0) break;
        try {
          const candidates = await resolveScopedYahooCaptureSecurities(
            deps.client,
            setting.userId,
          );
          if (candidates.length === 0) continue;
          const timezones = await resolveSecurityMarketTimezones(
            deps.client,
            candidates.map((candidate) => candidate.securityId),
          );
          for (const candidate of candidates) {
            if (yahooBudgetRemaining <= 0) break;
            const timezone = timezones.get(candidate.securityId) ?? null;
            if (!timezone) continue;
            const windowStatus = resolveDailyCaptureWindowStatus(
              nowIso,
              timezone,
            );
            if (!windowStatus || !windowStatus.isWithinCaptureWindow) {
              continue;
            }
            yahooRequests += 1;
            yahooBudgetRemaining -= 1;
            const result = await provider.getLatestObservation({
              mappingId: candidate.mappingId,
              securityId: candidate.securityId,
              scope: DEPLOYMENT_SCOPE,
            });
            if (!result.ok || result.value === null) continue;
            const observation = result.value;
            if (observation.marketDate !== windowStatus.localDate) continue;
            const captured = await insertIntradayPricePoint(deps.client, {
              userId: setting.userId,
              securityId: candidate.securityId,
              providerId: YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
              priceDecimal: observation.closeDecimal,
              currencyCode: observation.currencyCode,
              marketDate: observation.marketDate,
              marketTimezone: observation.marketTimezone,
              observedAt: observation.observationAt,
              capturedAt: nowIso,
              delayedMinutes: observation.delayedMinutes,
              quality: observation.quality,
              providerRevisionId: observation.providerRevisionId,
            });
            if (captured.inserted) intradayPointsCaptured += 1;
          }
        } catch {
          // Per-owner isolation, same rationale as the Sharesight loop above.
        }
      }
    }

    // ------------------------------------------------------------------
    // Phase B: rollup + purge -- every configured owner, every tick,
    // regardless of whether phase A captured anything for them just now.
    // ------------------------------------------------------------------
    let rollupsFailed = 0;
    let firstRollupError: string | null = null;
    let firstRollupErrorKind: RollupFailureKind | null = null;
    const recordRollupFailure = (error: unknown): void => {
      // Review round B3: a genuine per-pair failure must be VISIBLE, never
      // swallowed into an "ok:true" summary that reads as full success --
      // `runScheduledDailyPriceCapture` (worker/scheduled-refresh.ts) logs a
      // degraded (non-"success") result whenever this is nonzero. Review
      // round F5: `firstRollupErrorKind` (a closed enum) is what the worker
      // log actually emits; `firstRollupError` (free text) stays here for
      // tests/deeper debugging only.
      rollupsFailed += 1;
      if (firstRollupError === null) {
        firstRollupError =
          error instanceof Error ? error.message : String(error);
        firstRollupErrorKind = classifyRollupFailure(error);
      }
    };
    for (const setting of settings) {
      const providerId = providerIdForSource(setting.dailyCaptureSource);
      let candidates: Awaited<
        ReturnType<typeof resolveDailyCaptureRollupCandidates>
      >;
      try {
        candidates = await resolveDailyCaptureRollupCandidates(deps.client, {
          userId: setting.userId,
          providerId,
        });
      } catch (error) {
        recordRollupFailure(error);
        continue;
      }
      // Review round B1/B3: each PAIR gets its OWN try/catch -- an earlier
      // version wrapped the whole per-owner loop in one try/catch, so a
      // single wedged (oldest, since candidates are market_date-ASC-ordered)
      // day silently blocked every LATER day for that owner, every tick,
      // forever. A genuine per-pair failure must never prevent this owner's
      // OTHER pairs from being attempted in the SAME tick.
      for (const candidate of candidates.slice(
        0,
        DAILY_CAPTURE_LIMITS.maxRollupPairsPerUserPerSweep,
      )) {
        try {
          if (!candidate.marketTimezone) continue;
          const windowStatus = resolveDailyCaptureWindowStatus(
            nowIso,
            candidate.marketTimezone,
          );
          if (!windowStatus) continue;
          if (
            !isDailyCaptureRollupEligible(candidate.marketDate, windowStatus)
          ) {
            continue;
          }
          const point = await selectLastIntradayPricePoint(deps.client, {
            userId: setting.userId,
            providerId,
            securityId: candidate.securityId,
            marketDate: candidate.marketDate,
          });
          if (!point) continue;
          const rollupResult = await rollupIntradayPricePoint(deps.client, {
            userId: setting.userId,
            providerId,
            securityId: candidate.securityId,
            point,
            now: nowIso,
          });
          if (!rollupResult.ok) {
            skippedNoMapping += 1;
            continue;
          }
          if (rollupResult.written) rolledUp += 1;
          const purgeResult = await purgeIntradayPricePoints(deps.client, {
            userId: setting.userId,
            providerId,
            securityId: candidate.securityId,
            marketDate: candidate.marketDate,
          });
          purged += purgeResult.purged;
        } catch (error) {
          // Purge is intentionally NOT reached on this path -- "purge only
          // after successful rollup" (the intraday cache stays intact for a
          // later retry).
          recordRollupFailure(error);
        }
      }
    }

    return {
      ok: true,
      usersProcessed: settings.length,
      sharesightRequests,
      yahooRequests,
      intradayPointsCaptured,
      rolledUp,
      purged,
      skippedNoMapping,
      rollupsFailed,
      firstRollupError,
      firstRollupErrorKind,
    };
  } catch {
    return { ok: false, reason: "database" };
  }
}
