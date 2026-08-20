import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  listEnabledSharesightUserIds,
  recordSharesightPriceRefreshWatermark,
  resolveScopedSharesightInstrumentSecurities,
  upsertSharesightPriceObservations,
} from "../db/repositories/sharesight-price-refresh.ts";
import {
  buildSharesightPriceAccretionPlan,
  type SharesightClient,
} from "../domain/sharesight/index.ts";

// BRK-012B: owner-scoped, bounded, idempotent price refresh orchestration.
// `listUserInstruments` is fetched ONCE per run (one Sharesight account,
// deployment-wide `client_credentials` config -- see
// `worker/sharesight-config.ts`), then matched per enabled owner against
// their OWN `portfolio_securities` scope (never cross-user) and upserted.
//
// Trigger gating (TASKS.md ruling): "only for users with an enabled
// sharesight link + credentials configured". Both are prerequisites for ANY
// work happening at all, mirroring `worker/scheduled-refresh.ts`'s existing
// `marketDataProvider === 'disabled'` skip pattern for the Yahoo sweep --
// neither an absent Sharesight client NOR zero enabled links makes a single
// database write or a single Sharesight request; both are a `skipped: true`
// no-op, not a "failure" needing a watermark write. A REAL failure is
// different -- recorded explicitly, on every affected link, per the "never
// partial-silent" ruling. Two distinct failure classes exist and both are
// covered: (1) the SHARED fetch itself failing (one Sharesight account, one
// call -- every enabled link shares the same outcome); (2) a PER-USER
// DB-write failure during the resolve/write phase (BRK-012B review finding
// F2) -- the fetch succeeded, but writing THIS user's observations failed,
// which must not silently skip that user's watermark while other users'
// passes continue normally.

export type SharesightPriceRefreshRunResult =
  | {
      ok: true;
      skipped: boolean;
      usersProcessed: number;
      /** Count of users whose resolve/write phase threw (class (2) above) --
       * each one still got an honest `status = 'failed'` watermark write
       * (best-effort; see the per-user catch block below), and processing
       * continued for every OTHER enabled user. */
      usersFailed: number;
      matchedCount: number;
      unmatchedCount: number;
      /** Sum of `SharesightPriceAccretionPlan.invalidTimestampCount` across
       * every processed user -- see `domain/sharesight/price-accretion.ts`.
       * Expected to be zero in practice (the parse layer already validates
       * timestamp shape), disclosed honestly rather than silently dropped. */
      invalidTimestampCount: number;
      observationsWritten: number;
    }
  | {
      ok: false;
      reason: "fetch_failed";
      errorKind: string;
      usersMarkedFailed: number;
    };

export type SharesightPriceRefreshDeps = Readonly<{
  client: SqlClient;
  /** `null` means the Sharesight integration is not configured for this
   * deployment (`worker/sharesight-config.ts`'s `{ enabled: false }` state)
   * -- never a way to smuggle a live client into a disabled-looking run. */
  sharesightClient: SharesightClient | null;
  now?: () => string;
}>;

export async function runSharesightPriceRefresh(
  deps: SharesightPriceRefreshDeps,
): Promise<SharesightPriceRefreshRunResult> {
  const now = deps.now ?? (() => new Date().toISOString());

  // Gate 1: credentials configured at all. Zero DB reads, zero Sharesight
  // requests when not.
  if (!deps.sharesightClient) {
    return {
      ok: true,
      skipped: true,
      usersProcessed: 0,
      usersFailed: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      invalidTimestampCount: 0,
      observationsWritten: 0,
    };
  }

  // Gate 2: at least one owner has an enabled link. Zero Sharesight
  // requests when not -- the whole point of the cron-gating rule ("no link
  // -> no fetch").
  const userIds = await listEnabledSharesightUserIds(deps.client);
  if (userIds.length === 0) {
    return {
      ok: true,
      skipped: true,
      usersProcessed: 0,
      usersFailed: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      invalidTimestampCount: 0,
      observationsWritten: 0,
    };
  }

  // ONE call covers every instrument across every one of this account's
  // Sharesight portfolios (BRK-012A evidence) -- never one call per local
  // user/portfolio.
  const result = await deps.sharesightClient.listUserInstruments();
  const nowIso = now();
  if (!result.ok) {
    // Never partial-silent: every enabled link records the SAME honest
    // failure, since they all depend on the SAME single fetch that failed.
    for (const userId of userIds) {
      await recordSharesightPriceRefreshWatermark(deps.client, {
        userId,
        status: "failed",
        errorKind: result.error.kind,
        now: nowIso,
      });
    }
    return {
      ok: false,
      reason: "fetch_failed",
      errorKind: result.error.kind,
      usersMarkedFailed: userIds.length,
    };
  }

  let matchedCount = 0;
  let unmatchedCount = 0;
  let invalidTimestampCount = 0;
  let observationsWritten = 0;
  let usersFailed = 0;
  for (const userId of userIds) {
    try {
      // Owner-scoped resolution -- NEVER ticker text, NEVER another owner's
      // portfolio_securities (AGENTS.md: constrain every portfolio-scoped
      // query by the authenticated internal user_id).
      const scopeMap = await resolveScopedSharesightInstrumentSecurities(
        deps.client,
        userId,
      );
      const plan = buildSharesightPriceAccretionPlan(result.value, scopeMap);
      const write = await upsertSharesightPriceObservations(deps.client, {
        userId,
        candidates: plan.candidates,
        now: nowIso,
      });
      await recordSharesightPriceRefreshWatermark(deps.client, {
        userId,
        status: "ok",
        errorKind: null,
        now: nowIso,
      });
      matchedCount += plan.matchedCount;
      unmatchedCount += plan.unmatchedCount;
      invalidTimestampCount += plan.invalidTimestampCount;
      observationsWritten += write.written;
    } catch {
      // BRK-012B review finding F2: a DB-write failure during THIS user's
      // resolve/write phase must still record an honest failure watermark
      // -- "never partial-silent" applies to every failure class, not only
      // the shared fetch failure above. The watermark write itself is
      // best-effort (wrapped in its own try/catch): if it ALSO throws,
      // that must never abort the loop and silently skip every OTHER
      // still-enabled user's pass.
      usersFailed += 1;
      try {
        await recordSharesightPriceRefreshWatermark(deps.client, {
          userId,
          status: "failed",
          errorKind: "database",
          now: nowIso,
        });
      } catch {
        // Best-effort -- see comment above. Nothing further to do for
        // this user; the loop continues to the next one regardless.
      }
    }
  }

  return {
    ok: true,
    skipped: false,
    usersProcessed: userIds.length,
    usersFailed,
    matchedCount,
    unmatchedCount,
    invalidTimestampCount,
    observationsWritten,
  };
}
