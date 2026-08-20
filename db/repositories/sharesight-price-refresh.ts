import { randomUUID } from "node:crypto";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { SharesightPriceAccretionCandidate } from "../../domain/sharesight/price-accretion.ts";

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

/**
 * BRK-012B statement-budget discipline (CALC-003/UI-013 precedent): each
 * candidate security costs at most 2 statements in `upsertPriceObservations`'s
 * batch (1 guarded `security_provider_mappings` ensure -- a no-op SELECT
 * after the first successful run for that security -- plus 1 price_observations
 * upsert). `maxSecuritiesPerChunk: 25` therefore bounds a single `batch()`
 * call to at most 50 statements, comfortably under D1's documented 100-
 * statement `batch()` ceiling with 2x headroom for future per-candidate
 * statement growth, and well above BRK-012A's live-evidenced account size
 * (18 holdings) -- an owner-scale account fits in ONE chunk in practice.
 * Multiple chunks run as separate atomic `batch()` calls (not one giant
 * transaction) -- safe because accretion is idempotent, so a chunk that
 * fails after an earlier chunk committed leaves no partial/duplicated
 * observation, only a (visible, retryable) failed watermark for the run.
 * `maxUsersPerRun: 50` bounds the per-cron-tick owner fan-out; this
 * deployment currently has one real owner, so this is generous headroom,
 * not a measured production ceiling.
 */
export const SHARESIGHT_PRICE_REFRESH_LIMITS = Object.freeze({
  maxSecuritiesPerChunk: 25,
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
  }>,
): Promise<{ written: number }> {
  if (input.candidates.length === 0) return { written: 0 };

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
                ingested_at = excluded.ingested_at
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
