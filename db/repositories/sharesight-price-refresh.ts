import { randomUUID } from "node:crypto";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { SharesightPriceAccretionCandidate } from "../../domain/sharesight/price-accretion.ts";
import { buildOwnerValueHistoryInvalidationStatementGroups } from "./portfolio-value-history.ts";

// BRK-012B: write path for accreting Sharesight's `listUserInstruments`
// output into `price_observations`. Rulings (TASKS.md, BINDING):
//   - source = the `sharesight` `market_data_providers` row (0044 seed),
//     access_scope = 'user'/scope_user_id = the owner (prices fetched with
//     the owner's own credentials are user-scoped, never deployment-wide);
//   - scope: only securities the owner's `portfolio_securities` links (ANY
//     status, i.e. including a fully-exited position -- `status <>
//     'unresolved'` is the only filter, since `unresolved` rows carry no
//     `security_id` to resolve at all per the table's own CHECK), resolved
//     through `security_identifiers(scheme = 'sharesight_instrument')` --
//     NEVER ticker text (AGENTS.md non-negotiable);
//   - accretion: one row per (security, market_date, source, scope),
//     upserted via the NEW `price_observations_provider_scope_mapping_date_unique`
//     index (see db/schema.ts) so a same-day re-fetch OVERWRITES (converges
//     toward the close) rather than accumulating duplicate rows.

export const SHARESIGHT_PRICE_PROVIDER_ID = "sharesight";

/** D1's documented per-`batch()` statement ceiling. BUG-012 round-3 FU3:
 * the ONE place this number appears in this module -- every invalidation
 * budget below is DERIVED from it and from `maxSecuritiesPerChunk`, so the
 * two can never drift apart the way BUG-012 F3's hand-maintained
 * `MARKET_DATA_REFRESH_REPOSITORY_LIMITS.maxStatementsPerChunk` did. */
const D1_MAX_STATEMENTS_PER_BATCH = 100;

/** BUG-012 round-4: a DELIBERATE margin held back from
 * `D1_MAX_STATEMENTS_PER_BATCH`, restoring the 10-statement headroom the
 * round-2 implementation documented (90 of 100) and round 3 spent -- its
 * derivation put the worst-case atomic batch at EXACTLY 100.
 *
 * Rationale, stated as a limitation rather than a measurement: this suite
 * runs against node:sqlite, whose `batch()` is a local loop with no
 * statement ceiling at all, so a green suite is not evidence that a batch
 * of exactly 100 is accepted by production D1 -- and D1 has repeatedly
 * proven stricter than the local driver on limits of this kind. Sitting
 * exactly ON a documented ceiling also leaves no room for any future
 * per-chunk statement (a watermark, a progress row) without silently
 * re-breaching it. 10 is not derived from a measurement; it is the same
 * headroom this module carried before round 3 removed it, and it costs
 * only 5 inline portfolio groups (25 -> 20), with the remainder issued in
 * follow-on batches rather than dropped. */
const D1_BATCH_STATEMENT_MARGIN = 10;

/** The statements one `batch()` call may actually contain here: D1's
 * ceiling less the margin above. Every budget below derives from this, and
 * the call site measures its remaining room against it too. */
const MAX_STATEMENTS_PER_BATCH =
  D1_MAX_STATEMENTS_PER_BATCH - D1_BATCH_STATEMENT_MARGIN;

/** BRK-012B: each candidate security costs at most 2 statements in the
 * write half of this module's batch (1 guarded `security_provider_mappings`
 * ensure -- a no-op SELECT after that security's first successful run --
 * plus 1 `price_observations` upsert). */
const STATEMENTS_PER_SECURITY = 2;

/** BUG-012: `buildOwnerValueHistoryInvalidationStatementGroups` emits
 * exactly 2 statements per affected portfolio (the `portfolio_value_history`
 * DELETE plus the paired `portfolio_value_history_unresolvable` clear). */
const STATEMENTS_PER_INVALIDATED_PORTFOLIO = 2;

const MAX_SECURITIES_PER_CHUNK = 25;

/**
 * BRK-012B statement-budget discipline (CALC-003/UI-013 precedent).
 * `maxSecuritiesPerChunk: 25` x `STATEMENTS_PER_SECURITY` bounds the WRITE
 * half of one `batch()` call to at most 50 statements.
 *
 * BUG-012 F1: that same batch also carries the paired
 * `portfolio_value_history` / `portfolio_value_history_unresolvable`
 * invalidation for the (securityId, marketDate) targets the chunk just
 * wrote. BUG-012 round-3 B1 replaced the cross-owner, row-capped builder
 * with `buildOwnerValueHistoryInvalidationStatementGroups`
 * (`db/repositories/portfolio-value-history.ts`), which is scoped to the
 * WRITER's own `user_id` (a Sharesight write is `access_scope = 'user'`, so
 * another owner's portfolio is a provable no-op) and GROUPED per portfolio.
 * The invalidation cost is therefore 2 statements per affected portfolio of
 * the writer's, independent of the chunk's security count:
 *
 * BUG-012 round-4: every budget below is derived from
 * `MAX_STATEMENTS_PER_BATCH` (= 100 - the deliberate
 * `D1_BATCH_STATEMENT_MARGIN` of 10), not from D1's raw ceiling -- round 3
 * derived them from the raw 100 and so put the worst-case atomic batch at
 * EXACTLY 100, spending headroom this module had documented since round 2.
 *
 * - `maxInvalidationPortfoliosPerWriteBatch` = (90 - 25*2) / 2 = 20
 *   portfolio groups fit ALONGSIDE a full 25-security chunk's writes, in
 *   the same atomic batch (worst case 50 + 40 = 90 of D1's 100). Computed
 *   from the constants, never a hand-maintained literal; the call site
 *   recomputes the remaining room from the batch it ACTUALLY built (a
 *   short chunk leaves room for more groups than this worst case).
 * - `maxInvalidationPortfoliosPerFollowOnBatch` = 90 / 2 = 45 groups per
 *   follow-on `batch()` for any REMAINDER past that -- the remainder is
 *   ISSUED, never dropped. Pre-BUG-012-round-3 the excess was silently
 *   truncated by a `LIMIT`, which deterministically left marks and stale
 *   rows in place on every hourly run (reviewer-reproduced at 25 securities
 *   in one portfolio and at 22 portfolios on one security).
 *
 * The per-STATEMENT bound parameter count is bounded separately, by
 * `buildOwnerValueHistoryInvalidationStatementGroups` itself: a group's
 * two DELETEs bind `user_id` + `portfolio_id` + one parameter per targeted
 * date, and a chunk carries at most `maxSecuritiesPerChunk` distinct
 * market dates, so 27 of D1's 100-parameter ceiling in the worst case --
 * asserted there, not assumed here.
 *
 * Multiple chunks run as separate atomic `batch()` calls (not one giant
 * transaction) -- safe because accretion is idempotent, so a chunk that
 * fails after an earlier chunk committed leaves no partial/duplicated
 * observation, only a (visible, retryable) failed watermark for the run.
 * `maxUsersPerRun: 50` bounds the per-cron-tick owner fan-out; this
 * deployment currently has one real owner, so this is generous headroom,
 * not a measured production ceiling.
 */
export const SHARESIGHT_PRICE_REFRESH_LIMITS = Object.freeze({
  maxSecuritiesPerChunk: MAX_SECURITIES_PER_CHUNK,
  d1MaxStatementsPerBatch: D1_MAX_STATEMENTS_PER_BATCH,
  d1BatchStatementMargin: D1_BATCH_STATEMENT_MARGIN,
  maxStatementsPerBatch: MAX_STATEMENTS_PER_BATCH,
  statementsPerSecurity: STATEMENTS_PER_SECURITY,
  statementsPerInvalidatedPortfolio: STATEMENTS_PER_INVALIDATED_PORTFOLIO,
  maxInvalidationPortfoliosPerWriteBatch: Math.floor(
    (MAX_STATEMENTS_PER_BATCH -
      MAX_SECURITIES_PER_CHUNK * STATEMENTS_PER_SECURITY) /
      STATEMENTS_PER_INVALIDATED_PORTFOLIO,
  ),
  maxInvalidationPortfoliosPerFollowOnBatch: Math.floor(
    MAX_STATEMENTS_PER_BATCH / STATEMENTS_PER_INVALIDATED_PORTFOLIO,
  ),
  maxUsersPerRun: 50,
});

/**
 * Owner-scoped: only users with at least one ENABLED `sharesight_sync_state`
 * row are refresh candidates (the cron-gating rule -- "no link -> no
 * fetch"). Distinct, since one owner can link several local portfolios to
 * the same Sharesight account.
 */
export async function listEnabledSharesightUserIds(
  client: SqlClient,
  limit: number = SHARESIGHT_PRICE_REFRESH_LIMITS.maxUsersPerRun,
): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("invalid_sharesight_price_refresh_user_limit");
  }
  const rows = await client.all<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM sharesight_sync_state
     WHERE enabled = 1 ORDER BY user_id ASC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => row.user_id);
}

/**
 * Resolves the owner's `sharesight_instrument` -> `security_id` scope map.
 * Joined through `portfolio_securities` (ANY status except `unresolved`,
 * which by the table's own CHECK constraint never carries a `security_id`
 * to resolve anyway) so an EXITED holding (still `held`/`watch`/`hidden`
 * with a resolved `security_id`, just zero current quantity) stays
 * in-scope -- there is no quantity filter here, matching this task's
 * ruling #4 ("any status incl. exited"). Never touches ticker text.
 */
export async function resolveScopedSharesightInstrumentSecurities(
  client: SqlClient,
  userId: string,
): Promise<Map<string, string>> {
  // BRK-012B review finding F3: `ORDER BY` added for deterministic
  // resolution -- this feeds a `Map`, so row ORDER only matters if the same
  // `instrument_id` could ever appear twice for one owner (it structurally
  // cannot today: `security_identifiers_sharesight_instrument_unique` is a
  // partial unique index on `(scheme, value) WHERE valid_to IS NULL`, so at
  // most one ACTIVE identifier row exists per instrument id globally, let
  // alone per owner). Ordering is still added defensively so this
  // function's output is reproducible/diffable across runs and does not
  // depend on the database's unspecified default row order.
  const rows = await client.all<{
    instrument_id: string;
    security_id: string;
  }>(
    `SELECT DISTINCT si.value AS instrument_id, ps.security_id AS security_id
       FROM security_identifiers si
       JOIN portfolio_securities ps ON ps.security_id = si.security_id
      WHERE si.scheme = 'sharesight_instrument' AND si.valid_to IS NULL
        AND ps.user_id = ? AND ps.status <> 'unresolved'
      ORDER BY si.value ASC, ps.security_id ASC`,
    [userId],
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.instrument_id, row.security_id);
  }
  return map;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Upserts one accretion candidate per (security, market_date) for the given
 * owner. Each security's FIRST-ever accretion write also guard-inserts a
 * `security_provider_mappings` row for `provider_id = 'sharesight'`
 * (`price_observations.mapping_id` is a hard, non-null FK into that table
 * -- see db/schema.ts's `price_observations_mapping_provider_security_fk`
 * -- so a write cannot happen without one). The guard uses the SAME
 * "INSERT ... SELECT ... WHERE NOT EXISTS" + inline-subquery-reread
 * technique `db/repositories/security-resolution.ts` establishes for
 * guarded creates: the price_observations statement's `mapping_id` is
 * itself a subquery re-reading `security_provider_mappings`, so it sees
 * EITHER a pre-existing mapping OR the one the guard statement just
 * inserted earlier in the SAME atomic `batch()` call -- never a stale/
 * mismatched id captured before the guard ran.
 *
 * The upsert's `ON CONFLICT` target repeats the new index's `WHERE
 * provider_id = 'sharesight'` partial-index condition (db/schema.ts's
 * `price_observations_provider_scope_mapping_date_unique`) -- SQLite only
 * matches an `ON CONFLICT (columns)` clause against a PARTIAL unique index
 * when the conflict clause's own `WHERE` repeats that index's condition
 * verbatim; without it SQLite reports "ON CONFLICT clause does not match
 * any PRIMARY KEY or UNIQUE constraint" (verified the hard way while fixing
 * this). Every value this repository ever writes here already has
 * `provider_id = 'sharesight'` (see `SHARESIGHT_PRICE_PROVIDER_ID`
 * throughout), so this is a statically-true repeat of already-known state,
 * never a behavioural filter.
 */
export async function upsertSharesightPriceObservations(
  client: SqlClient,
  input: Readonly<{
    userId: string;
    candidates: readonly SharesightPriceAccretionCandidate[];
    now: string;
    /**
     * MKT-015 (review round 2026-08-22, B3, BLOCKING): when `true`, the
     * `ON CONFLICT ... DO UPDATE` below is additionally guarded by
     * `excluded.observation_at > price_observations.observation_at` -- the
     * SAME never-downgrade pattern `app/watchlist-actions.ts`'s best-effort
     * priming upsert already uses. ONLY the MKT-015 backfill write path
     * (`app/sharesight-price-gate-service.ts`'s call for a PRIOR day's row,
     * built from a delayed-price cache snapshot that may be hours or days
     * stale by the time it is finally written) passes this. The ORDINARY
     * refresh path -- writing TODAY's row, deliberately converging toward
     * the close as the day progresses via repeated same-day intraday
     * upserts -- is UNCHANGED and must NEVER gain this guard: an ordinary
     * later-in-the-day observation always legitimately has a LATER
     * `observation_at` than an earlier one, so the guard is a no-op there
     * in the common case, but this stays scoped to the one path the review
     * actually found a real downgrade risk on (a stale cache snapshot
     * racing an independently-fresher write, e.g. from the hourly cron,
     * for the SAME prior day) rather than changing behaviour nobody asked
     * to change. Defaults to `false` (existing unconditional
     * converge-to-latest semantics, byte-identical SQL when omitted).
     */
    noDowngrade?: boolean;
  }>,
): Promise<{ written: number }> {
  if (input.candidates.length === 0) return { written: 0 };

  const conflictGuardClause = input.noDowngrade
    ? "\n                WHERE excluded.observation_at > price_observations.observation_at"
    : "";

  let written = 0;
  for (const batchCandidates of chunk(
    input.candidates,
    SHARESIGHT_PRICE_REFRESH_LIMITS.maxSecuritiesPerChunk,
  )) {
    const statements: SqlStatement[] = [];
    // BRK-012B review finding F3: tracks which statement INDEX in this
    // chunk's batch is each candidate's price_observations write, so the
    // `written` count below can be computed from what the database
    // actually reports affected/returned, never assumed from the input
    // list's own length (a guard failure -- the mapping subquery resolving
    // to NULL -- silently inserts zero rows for that candidate, and the
    // OLD `written += batchCandidates.length` counted it anyway).
    const priceObservationStatementIndices: number[] = [];
    for (const candidate of batchCandidates) {
      // BRK-012B follow-up 1 (review, 2026-08-20, documented not fixed --
      // fail-safe, not a bug): this guard-created mapping's `provider_exchange`/
      // `provider_symbol` become STATUS-AGNOSTIC exchange evidence the
      // moment this row exists -- `domain/securities/resolve-security*.ts`'s
      // same-user/global-ticker-currency fallback tiers read
      // `security_provider_mappings.provider_exchange` as exchange evidence
      // for a security REGARDLESS of `status` (never filtered to
      // `'verified'` there). A security that previously resolved cleanly on
      // ticker+currency alone (no exchange evidence, "no contradiction" =
      // match) can, once this Sharesight mapping exists, surface as a
      // CONFLICT instead if a LATER independent resolution attempt's own
      // exchange evidence (e.g. a CSV row's `source_exchange_alias`)
      // disagrees textually with this row's `provider_exchange` (Sharesight's
      // own `market_code`, e.g. `"ASX"`). This is a FAIL-SAFE consequence,
      // not a data-corruption risk -- the resolver's existing rule
      // (disagreement = conflict, never silently guessed) is exactly what
      // fires, doing precisely what it is designed to do; the ONLY change
      // is that a Sharesight-priced security now carries exchange evidence
      // it previously lacked. See docs/DATA_MODEL.md's `security_provider_mappings`
      // section for the one-line pointer to this note. Not fixed here --
      // the alternative (never writing `provider_exchange` at all, or
      // writing a placeholder) would make this FK-anchor mapping
      // structurally different from every other provider's mapping row for
      // no evidence-based reason, and the resolver's conflict-surfacing
      // behavior is the CORRECT fail-safe outcome, not a defect to route
      // around.
      statements.push({
        sql: `INSERT INTO security_provider_mappings (
                id, security_id, provider_id, provider_exchange, provider_symbol,
                valid_from, valid_to, status, verified_by_user_id, verified_at
              )
              SELECT ?, ?, ?, ?, ?, ?, NULL, 'candidate', NULL, NULL
              WHERE NOT EXISTS (
                SELECT 1 FROM security_provider_mappings
                WHERE provider_id = ? AND security_id = ? AND valid_to IS NULL
              )`,
        params: [
          randomUUID(),
          candidate.securityId,
          SHARESIGHT_PRICE_PROVIDER_ID,
          candidate.marketCode,
          candidate.instrumentCode,
          input.now.slice(0, 10),
          SHARESIGHT_PRICE_PROVIDER_ID,
          candidate.securityId,
        ],
      });
      const mappingIdSubquery = `(SELECT id FROM security_provider_mappings
              WHERE provider_id = ? AND security_id = ? AND valid_to IS NULL LIMIT 1)`;
      priceObservationStatementIndices.push(statements.length);
      statements.push({
        sql: `INSERT INTO price_observations (
                id, provider_id, access_scope, scope_user_id, scope_key,
                mapping_id, security_id, interval, observation_at, market_date,
                market_timezone, currency_code, close_decimal,
                previous_close_decimal, adjustment_state, quality,
                delayed_minutes, ingested_at, provider_revision_id, payload_sha256
              )
              SELECT ?, ?, 'user', ?, ?, ${mappingIdSubquery}, ?, 'delayed', ?, ?, ?, ?, ?, NULL, 'raw', 'observed', NULL, ?, NULL, NULL
              WHERE ${mappingIdSubquery} IS NOT NULL
              ON CONFLICT (
                provider_id, scope_key, mapping_id, interval, market_date,
                adjustment_state
              ) WHERE provider_id = 'sharesight'
              DO UPDATE SET
                observation_at = excluded.observation_at,
                market_timezone = excluded.market_timezone,
                currency_code = excluded.currency_code,
                close_decimal = excluded.close_decimal,
                ingested_at = excluded.ingested_at${conflictGuardClause}
              RETURNING id`,
        params: [
          randomUUID(),
          SHARESIGHT_PRICE_PROVIDER_ID,
          input.userId,
          input.userId,
          SHARESIGHT_PRICE_PROVIDER_ID,
          candidate.securityId,
          candidate.securityId,
          candidate.observationAt,
          candidate.marketDate,
          candidate.marketTimezone,
          candidate.currencyCode,
          candidate.closeDecimal,
          input.now,
          SHARESIGHT_PRICE_PROVIDER_ID,
          candidate.securityId,
        ],
      });
    }
    // BUG-012 F1: a Sharesight write can land a fresher/backfilled price
    // for a date this owner's held portfolios already have a stored
    // value-history row (or an unresolvable mark) for -- see this file's
    // `SHARESIGHT_PRICE_REFRESH_LIMITS` doc comment for the statement-
    // budget accounting.
    //
    // BUG-012 round-3 B1: OWNER-SCOPED and GROUPED PER PORTFOLIO. This
    // write is `access_scope = 'user'` / `scope_user_id = input.userId`,
    // and the read path's `PRICE_SCOPE` admits a user-scoped observation
    // only for its own owner -- so a statement against ANOTHER owner's
    // portfolio could never change what that owner reads, while (under the
    // old cross-owner builder's row cap) it did consume the budget and
    // starve this writer's own portfolios. Grouping per portfolio also
    // makes the cost 2 statements per affected portfolio instead of 2 per
    // (portfolio, security) row, so a 25-security chunk in ONE portfolio
    // costs 2 statements, not 50.
    //
    // BUG-012 round-4 B1: one target per (security, marketDate) -- the
    // EXACT dates this chunk wrote, never a folded range. A halted or
    // unlisted instrument's `current_price_updated_at` can be months
    // behind a live one's, and the round-3 `[MIN, MAX]` span deleted every
    // stored row and mark in between on every hourly tick.
    const invalidationTargets = batchCandidates.map((candidate) => ({
      securityId: candidate.securityId,
      marketDate: candidate.marketDate,
    }));
    const invalidationGroups =
      await buildOwnerValueHistoryInvalidationStatementGroups(
        client,
        input.userId,
        invalidationTargets,
      );
    // Room left in THIS chunk's atomic batch, measured against the
    // statements actually built (not the worst case) -- see
    // `SHARESIGHT_PRICE_REFRESH_LIMITS.maxInvalidationPortfoliosPerWriteBatch`.
    const inlineGroupCapacity = Math.max(
      0,
      Math.floor(
        (SHARESIGHT_PRICE_REFRESH_LIMITS.maxStatementsPerBatch -
          statements.length) /
          SHARESIGHT_PRICE_REFRESH_LIMITS.statementsPerInvalidatedPortfolio,
      ),
    );
    const inlineGroups = invalidationGroups.slice(0, inlineGroupCapacity);
    const tailGroups = invalidationGroups.slice(inlineGroups.length);
    for (const group of inlineGroups) statements.push(...group);
    const results = await client.batch(statements);
    // `RETURNING id` (above) + counting returned ROWS, never `changes` --
    // portable across both the D1 batch adapter and the local
    // node:sqlite-backed test harness, whose `batch()` does not populate
    // per-statement `changes` (it always reports `0`, unlike a single
    // `run()` call) but DOES populate `results` from a RETURNING clause on
    // either backend.
    for (const index of priceObservationStatementIndices) {
      written += results[index]?.results.length ?? 0;
    }
    // Any REMAINDER past the atomic batch's room is ISSUED immediately
    // after it, never dropped (the defect BUG-012 round-3 B1 fixed) --
    // follow-on `client.batch()` calls, the same non-atomic-tail shape
    // `db/repositories/intraday-price-capture.ts`'s rollup invalidation and
    // `db/repositories/import-reversal.ts`'s deferred rebuild queueing
    // already use.
    //
    // SAFETY OF THE NON-ATOMIC TAIL (stated as a bound, not an assumption):
    // the price rows are already durable when a tail batch runs, so a
    // failure between the two leaves ONLY a stale cached value-history row
    // or an uncleared mark for the tail portfolios -- never a wrong price,
    // never a fabricated value; a stale mark still renders as an honestly
    // absent date. It self-heals on the next write of the same dates, which
    // recomputes the SAME grouped targets from the same query: the hourly
    // refresh rewrites today's date every tick, so today's tail is retried
    // within the hour. For a one-off PRIOR-day backfill (MKT-015) there is
    // no such guaranteed next write, so that residual persists until
    // another write touches the date -- the identical residual the intraday
    // rollup's own separate-batch invalidation already accepts. This tail
    // only exists at all for an owner holding one chunk's securities across
    // more than ~20 of their OWN portfolios.
    for (const followOnGroups of chunk(
      tailGroups,
      SHARESIGHT_PRICE_REFRESH_LIMITS.maxInvalidationPortfoliosPerFollowOnBatch,
    )) {
      await client.batch(followOnGroups.flat());
    }
  }
  return { written };
}

export type SharesightPriceRefreshWatermarkInput = Readonly<{
  userId: string;
  status: "ok" | "failed";
  errorKind: string | null;
  now: string;
}>;

/** BRK-012B review finding F4: `SharesightPriceRefreshWatermarkInput.status`
 * was TypeScript-only enforced -- a compile-time union with no runtime
 * check in `recordSharesightPriceRefreshWatermark` below, unlike this
 * table's `enabled` column (which DOES have a DB `CHECK`). Since a new
 * table-level `CHECK` cannot be added here without a rebuild (see this
 * file's header comment and db/schema.ts's identical note), this runtime
 * guard is the enforcement instead -- genuinely fails closed against any
 * caller that bypasses TypeScript (a cast, a future JS caller, a
 * mis-typed test double), not merely documented as validated. */
const VALID_WATERMARK_STATUSES = new Set(["ok", "failed"]);

/**
 * Records the refresh attempt's outcome on EVERY enabled `sharesight_sync_state`
 * row for this owner (an owner may link several local portfolios to the
 * same Sharesight account; `listUserInstruments` is fetched once per owner,
 * so every linked row's watermark reflects the same attempt). Deliberately
 * does NOT touch `version` -- that column guards OWNER-INITIATED mutations
 * (enable/disable via the sync-state repository's `upsert`); a background
 * refresh watermark write is system-internal, never races an owner action
 * on the SAME field, and bumping `version` here would make an owner's
 * concurrent `expectedVersion`-guarded save spuriously conflict with a
 * cron tick that changed nothing the owner cares about. Never
 * partial-silent: a failure writes `status = 'failed'` + `errorKind`
 * exactly like a success writes `status = 'ok'` -- there is no third,
 * unrecorded outcome.
 */
export async function recordSharesightPriceRefreshWatermark(
  client: SqlClient,
  input: SharesightPriceRefreshWatermarkInput,
): Promise<void> {
  if (!VALID_WATERMARK_STATUSES.has(input.status)) {
    throw new Error("invalid_sharesight_price_refresh_status");
  }
  await client.run(
    `UPDATE sharesight_sync_state
     SET last_price_refresh_at = ?, last_price_refresh_status = ?,
         last_price_refresh_error_kind = ?, updated_at = ?
     WHERE user_id = ? AND enabled = 1`,
    [input.now, input.status, input.errorKind, input.now, input.userId],
  );
}

/**
 * BRK-012C review round (2026-08-20, B1 fix): reads this SAME watermark back
 * -- BRK-012B never needed to (only the cron WROTE it); the read gate
 * (`app/sharesight-price-gate-service.ts`) now uses it as its OWN per-owner
 * staleness fact instead of a per-security cache scan (a held security
 * Sharesight never matches can never have a cache row, so a per-security
 * check reported "stale" forever for a mixed portfolio -- the reviewer's B1
 * finding). Deliberately reads the EXISTING `last_price_refresh_at` column
 * rather than adding a second, near-duplicate "gate watermark" column set:
 * both the hourly cron and the read gate represent the identical fact
 * ("when did we last attempt a Sharesight price fetch for this owner, and
 * did it succeed"), and sharing one column means an hourly cron sweep
 * automatically "resets the gate clock" for free (review follow-up 2) --
 * with no second field to keep in sync or ever risk drifting from the
 * first. Reads the FIRST enabled row (`ORDER BY id ASC LIMIT 1`) -- every
 * enabled row for an owner is written identically by
 * `recordSharesightPriceRefreshWatermark` above (its own `WHERE user_id = ?
 * AND enabled = 1`, no `id` filter), so any one of them carries the same
 * value. Returns `null` when this owner has no enabled link at all (the
 * caller checks that separately) or has never had an attempt recorded.
 */
export async function loadSharesightPriceRefreshWatermark(
  client: SqlClient,
  userId: string,
): Promise<string | null> {
  const row = await client.get<{ last_price_refresh_at: string | null }>(
    `SELECT last_price_refresh_at FROM sharesight_sync_state
      WHERE user_id = ? AND enabled = 1 ORDER BY id ASC LIMIT 1`,
    [userId],
  );
  return row?.last_price_refresh_at ?? null;
}

/** PRF-011: what `app/sharesight-price-gate-service.ts`'s gates 2 and 3
 * actually need, from ONE read instead of the two separate reads
 * (`hasEnabledSharesightLink` then `loadSharesightPriceRefreshWatermark`)
 * it used to issue against this SAME `sharesight_sync_state` row. `linked:
 * false` is the exact "no enabled row" case `hasEnabledSharesightLink`
 * returned `false` for -- the gate's `not_linked` short-circuit stays
 * zero-fetch beyond this single read. `linked: true` distinguishes a row
 * that exists but has never recorded an attempt (`lastAttemptAt: null`,
 * always stale) from one with a real watermark, exactly like the old
 * two-call sequence did. Deliberately does not replace
 * `hasEnabledSharesightLink`/`loadSharesightPriceRefreshWatermark` above --
 * both remain exported and directly unit-tested (`tests/brk-012c.test.ts`)
 * for callers that only need one half of this fact. */
export type SharesightPriceGateLinkStatus =
  { linked: false } | { linked: true; lastAttemptAt: string | null };

export async function loadSharesightPriceGateLinkStatus(
  client: SqlClient,
  userId: string,
): Promise<SharesightPriceGateLinkStatus> {
  const row = await client.get<{ last_price_refresh_at: string | null }>(
    `SELECT last_price_refresh_at FROM sharesight_sync_state
      WHERE user_id = ? AND enabled = 1 ORDER BY id ASC LIMIT 1`,
    [userId],
  );
  if (!row) return { linked: false };
  return { linked: true, lastAttemptAt: row.last_price_refresh_at ?? null };
}
